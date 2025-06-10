from ceapp import app

from flask import request, jsonify
import subprocess
import json
import re
import os
import ipaddress

def run_command(command_list, timeout=10):
    """コマンドを実行し、標準出力を返す"""
    try:
        print(f"Executing command: {' '.join(command_list)}")
        result = subprocess.run(command_list, capture_output=True, text=True, check=True, timeout=timeout)
        #print(f"Stdout: {result.stdout.strip()}")
        if result.stderr:
            print(f"Stderr: {result.stderr.strip()}")
        return result.stdout.strip(), result.stderr.strip() if result.stderr else ""
    except subprocess.CalledProcessError as e:
        print(f"Error running command {' '.join(command_list)}: {e}")
        #print(f"Stdout (if any): {e.stdout.strip()}")
        print(f"Stderr: {e.stderr.strip()}")
        return e.stdout.strip() if e.stdout else None, e.stderr.strip()
    except subprocess.TimeoutExpired:
        print(f"Timeout running command {' '.join(command_list)}")
        return None, "Command timed out"
    except FileNotFoundError:
        print(f"Error: Command '{command_list[0]}' not found.")
        return None, f"Command '{command_list[0]}' not found."
    except Exception as e:
        print(f"An unexpected error occurred: {e}")
        return None, str(e)

def get_clab_containers():
    """Containerlabで管理されていると思われるコンテナ名一覧を取得"""
    stdout, stderr = run_command(["docker", "ps", "--format", "{{.Names}}", "--filter", "name=clab-"])
    if stdout:
        containers = stdout.splitlines()
        containers = [c.strip() for c in containers if c.strip()]
        print(f"Detected containers: {containers}")
        return containers
    if stderr and "Cannot connect to the Docker daemon" in stderr:
        print(f"Failed to connect to Docker daemon: {stderr}")
    elif stderr:
        print(f"Failed to get containers, stderr: {stderr}")
    else:
        print("No clab containers found.")
    return []

def get_container_interface_details(container_name):
    cmd = ["docker", "exec", container_name, "ip", "-j", "addr"]
    stdout, stderr = run_command(cmd)
    interfaces = []
    if stdout:
        try:
            data = json.loads(stdout)
            for iface_data in data:
                if iface_data.get("link_type") == "loopback" or not iface_data.get("operstate") == "UP":
                    continue
                if_name = iface_data.get("ifname")
                mac_address = iface_data.get("address")
                ip_infos = []
                for addr_info in iface_data.get("addr_info", []):
                    if addr_info.get("family") == "inet":
                        ip_cidr = f"{addr_info['local']}/{addr_info['prefixlen']}"
                        ip_infos.append(ip_cidr)
                if if_name and ip_infos:
                    interfaces.append({
                        "name": if_name,
                        "mac": mac_address,
                        "ips_cidr": ip_infos
                    })
        except json.JSONDecodeError:
            print(f"Error decoding 'ip addr' JSON for {container_name}. Output: {stdout[:200]}... Stderr: {stderr}")
        except KeyError as e:
            print(f"KeyError parsing 'ip addr' JSON for {container_name}: {e}")
    elif stderr:
        print(f"Failed to get interface details for {container_name} using 'ip addr'. Stderr: {stderr}")
    else:
        print(f"No output from 'ip addr' for {container_name}, and no explicit error captured.")
    return interfaces

def get_links_from_networks(containers):
    all_interfaces_details = {}
    for container_name in containers:
        details = get_container_interface_details(container_name)
        if details:
            all_interfaces_details[container_name] = details
    subnet_map = {}
    for container_name, ifaces in all_interfaces_details.items():
        for iface in ifaces:
            for ip_cidr_str in iface["ips_cidr"]:
                try:
                    ip_interface = ipaddress.ip_interface(ip_cidr_str)
                    ip_network = ip_interface.network
                    if ip_network.is_link_local or ip_network.is_loopback:
                        continue
                    if ip_network not in subnet_map:
                        subnet_map[ip_network] = []
                    subnet_map[ip_network].append(container_name)
                except ValueError:
                    continue
    links = set()
    for subnet, connected_containers in subnet_map.items():
        unique_containers = sorted(list(set(connected_containers)))
        if len(unique_containers) == 2:
            links.add(tuple(unique_containers))
    link_list = [list(link) for link in links]
    print(f"Detected links (IP subnet based): {link_list}")
    return link_list

# --- API Routes ---
@app.route('/api/insert/topology', methods=['GET'])
def get_topology():
    containers = get_clab_containers()
    links = get_links_from_networks(containers)

    interfaces_by_container = {}
    for c in containers:
        interfaces_by_container[c] = [if_detail['name'] for if_detail in get_container_interface_details(c)]

    return jsonify({'containers': containers, 'links': links, 'interfaces_by_container': interfaces_by_container})

@app.route('/api/insert/fault', methods=['POST'])
def inject_fault_api():
    data = request.get_json()
    fault_type = data.get('fault_type')
    
    # 共通的に使われる可能性のあるパラメータ
    target_node = data.get('target_node') # link_down/up以外の多くの障害で対象ノードとして使用
    target_interface = data.get('target_interface') # link_down/up, tc関連で使用

    # link_down/up 専用
    target_link_str = data.get('target_link')
    
    # --- tc: add_latency 用パラメータ ---
    latency_ms = data.get('latency_ms')
    jitter_ms = data.get('jitter_ms') # オプション
    correlation_percent = data.get('correlation_percent') # オプション
    # --- tc: add_latency 用パラメータ終わり ---

    # --- tc: limit_bandwidth 用パラメータ ---
    bandwidth_rate_kbit = data.get('bandwidth_rate_kbit')
    bandwidth_burst_bytes = data.get('bandwidth_burst_bytes') # 例: "32kb" or "32000"
    bandwidth_latency_ms = data.get('bandwidth_latency_ms') # TBFのlatencyパラメータ
    # --- tc: limit_bandwidth 用パラメータ終わり ---


    command_list = []
    target_display = ""
    message = ""
    status = "error"

    try:
        if fault_type == 'link_down' or fault_type == 'link_up':
            if not target_link_str or not target_interface: # --- target_interfaceも必須チェック ---
                return jsonify({'status': 'error', 'message': 'Target link and interface must be selected/entered for link operations.'})
            # target_link_str から操作対象のノードを特定する (例: リンクの片側)
            # 実際の操作は、選択されたリンクのどちらかのノードで行うか、あるいは両方か、設計による
            # ここでは、フロントエンドで target_node も選択させるか、リンクの片側を target_node として扱う
            if not target_node: # もし target_node が別途指定されていなければ、リンクの片側を使う
                 node_to_act_on = target_link_str.split('|')[0]
            else: # target_node が指定されていればそちらを優先
                 node_to_act_on = target_node

            target_display = f"{fault_type} on link {target_link_str.replace('|','-')} interface {target_interface} of node {node_to_act_on}"
            action = "down" if fault_type == 'link_down' else "up"
            command_list = ["docker", "exec", node_to_act_on, "ip", "link", "set", target_interface, action]

        elif fault_type in ['node_stop', 'node_start', 'node_pause', 'node_unpause']:
            if not target_node:
                return jsonify({'status': 'error', 'message': 'Target node must be selected.'})
            target_display = f"node {target_node}"
            action = fault_type.split('_')[1] 
            command_list = ["docker", action, target_node]
        
        # --- 追加: 遅延付与 (Add Latency) の処理 ---
        elif fault_type == 'add_latency':
            if not (target_node and target_interface and latency_ms):
                return jsonify({'status': 'error', 'message': 'Target Node, Target Interface, and Latency (ms) are required for adding latency.'})
            try:
                lat_val = int(latency_ms)
                if lat_val <= 0: raise ValueError("Latency must be positive.")
            except ValueError:
                return jsonify({'status': 'error', 'message': f'Invalid Latency value: {latency_ms}. Must be a positive integer.'})

            target_display = f"latency ({latency_ms}ms) on node {target_node}, interface {target_interface}"
            
            # tcコマンドの構築 (netem)
            # 既存のqdiscを置き換えるので、まず削除を試みる (冪等性のため。失敗しても続行)
            # run_command(["docker", "exec", target_node, "tc", "qdisc", "del", "dev", target_interface, "root"], check_return_code=False) # 古い設定をクリア (エラーは無視)
            
            tc_cmd_parts = ["docker", "exec", target_node, "tc", "qdisc", "add", "dev", target_interface, "root", "netem", "delay", f"{latency_ms}ms"]
            if jitter_ms:
                try:
                    jit_val = int(jitter_ms)
                    if jit_val > 0: tc_cmd_parts.extend(["jitter", f"{jit_val}ms"])
                except ValueError: app.logger.warning(f"Invalid jitter value '{jitter_ms}', ignoring.")
            if correlation_percent:
                try:
                    corr_val = int(correlation_percent)
                    if 0 <= corr_val <= 100: tc_cmd_parts.extend(["correlation", f"{corr_val}%"])
                except ValueError: app.logger.warning(f"Invalid correlation value '{correlation_percent}', ignoring.")
            
            command_list = tc_cmd_parts
            message += f"Attempting to add latency on {target_node}/{target_interface}. Previous qdisc (if any) on root will be replaced. "
        # --- 追加終わり ---

        # --- 追加: 帯域制限 (Limit Bandwidth) の処理 ---
        elif fault_type == 'limit_bandwidth':
            if not (target_node and target_interface and bandwidth_rate_kbit):
                return jsonify({'status': 'error', 'message': 'Target Node, Target Interface, and Bandwidth Rate (kbit) are required for limiting bandwidth.'})
            try:
                rate_val = int(bandwidth_rate_kbit)
                if rate_val <= 0: raise ValueError("Bandwidth rate must be positive.")
            except ValueError:
                return jsonify({'status': 'error', 'message': f'Invalid Bandwidth Rate value: {bandwidth_rate_kbit}. Must be a positive integer.'})

            target_display = f"bandwidth limit ({bandwidth_rate_kbit}kbit) on node {target_node}, interface {target_interface}"

            # tcコマンドの構築 (tbf)
            # run_command(["docker", "exec", target_node, "tc", "qdisc", "del", "dev", target_interface, "root"], check_return_code=False) # 古い設定をクリア (エラーは無視)

            # バーストサイズとTBFレイテンシのデフォルト値
            burst = bandwidth_burst_bytes or f"{int(bandwidth_rate_kbit) * 1000 // 8 // 10}" # レートの1/10秒分程度 (bytes)
            tbf_latency = bandwidth_latency_ms or "50ms"

            tc_cmd_parts = ["docker", "exec", target_node, "tc", "qdisc", "add", "dev", target_interface, "root", "tbf", 
                            "rate", f"{bandwidth_rate_kbit}kbit", "burst", str(burst), "latency", str(tbf_latency)]
            
            command_list = tc_cmd_parts
            message += f"Attempting to limit bandwidth on {target_node}/{target_interface}. Previous qdisc (if any) on root will be replaced. "
        # --- 追加終わり ---

        # --- 追加: tc設定解除 ---
        elif fault_type == 'tc_clear':
            if not (target_node and target_interface):
                return jsonify({'status': 'error', 'message': 'Target Node and Target Interface are required for clearing tc rules.'})
            target_display = f"tc rules on node {target_node}, interface {target_interface}"
            command_list = ["docker", "exec", target_node, "tc", "qdisc", "del", "dev", target_interface, "root"]
            message += f"Attempting to clear tc qdisc on {target_node}/{target_interface}. "
        # --- 追加終わり ---


        else:
            return jsonify({'status': 'error', 'message': f'Unknown fault type: {fault_type}'})

        if command_list:
            stdout, stderr = run_command(command_list)
            # tcコマンドは成功時にもstderrに何か出力することがあるので、厳密なエラー判定が難しい
            # "RTNETLINK answers: File exists" は、既に同じqdiscが存在する場合のエラーで、実質的には成功とみなせる場合もある
            if stderr and "file exists" in stderr.lower() and ("add" in command_list or "change" in command_list):
                message += f'Executed {fault_type} on {target_display}, but a qdisc might have already existed. Output: {stdout or stderr}'
                status = 'warning' # 成功に近いが警告
            elif stderr and any(err_keyword in stderr.lower() for err_keyword in ["error", "failed", "no such", "cannot", "invalid", "unknown"]):
                message += f'Failed to inject {fault_type} on {target_display}. Error: {stderr}'
                status = 'error'
            elif stdout is None and stderr is None and fault_type != 'tc_clear': # tc_clear は成功時出力なしがありうる
                message += f'Command execution for {fault_type} on {target_display} likely timed out or failed with no output.'
                status = 'error'
            else:
                 message += f'Successfully executed {fault_type} on {target_display}. Output: {stdout or stderr}'
                 status = 'success'
        else:
             message = 'Could not generate command for the selected fault.'
             status = 'error'

    except Exception as e:
        message = f'An unexpected error occurred: {str(e)}'
        status = 'error'
        app.logger.error(f"Inject fault API error: {e}", exc_info=True)

    return jsonify({'status': status, 'message': message.strip()})