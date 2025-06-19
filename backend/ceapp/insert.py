from ceapp import app

from flask import request, jsonify
import subprocess
import json
import re
import os
import ipaddress
import requests

"""
コマンドを実行し、標準出力を返す関数.
"""
def run_command(command_list, timeout=10):
    try:
        #print(f"Executing command: {' '.join(command_list)}")
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

"""
Containerlabで管理されていると思われるコンテナ名一覧を取得する関数.
"""
def get_clab_containers():
    stdout, stderr = run_command(["docker", "ps", "--format", "{{.Names}}", "--filter", "name=clab-"])
    if stdout:
        containers = stdout.splitlines()
        containers = [c.strip() for c in containers if c.strip()]
        #print(f"Detected containers: {containers}")
        return containers
    if stderr and "Cannot connect to the Docker daemon" in stderr:
        print(f"Failed to connect to Docker daemon: {stderr}")
    elif stderr:
        print(f"Failed to get containers, stderr: {stderr}")
    else:
        print("No clab containers found.")
    return []


"""
get_clab_containers()で得たコンテナ一覧から, インターフェースのアドレス情報を取得する関数.
"""
def get_container_interface_details(container_name):
    cmd = ["docker", "exec", container_name, "ip", "-j", "addr"]
    stdout, stderr = run_command(cmd)
    interfaces = []
    if stdout:
        try:
            data = json.loads(stdout)
            for iface_data in data:
                if iface_data.get("link_type") == "loopback" or not iface_data.get("operstate") == "UP":
                    # ループバックであるか, statusがDOWNであれば含めない
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

"""
get_container_interface_details()で得たインターフェース情報を, ネットワークに基づいてをマッピングする関数.
"""
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
    #print(f"Detected links (IP subnet based): {link_list}")
    return link_list


"""
以下, Flask API
"""
@app.route('/api/insert/topology', methods=['GET'])
def get_topology():
    containers = get_clab_containers()
    links = get_links_from_networks(containers)

    interfaces_by_container = {}
    for c in containers:
        interfaces_by_container[c] = [if_detail['name'] for if_detail in get_container_interface_details(c)]

    return jsonify({'containers': containers, 'links': links, 'interfaces_by_container': interfaces_by_container})

# --- measure.py のAPIを呼び出して障害フラグを設定/解除する関数 ---
MEASURE_API_BASE_URL = "http://localhost:5000/api/measure" # measure.pyが動作するURL

def set_measure_fault_flag(is_injected_flag: bool):
    try:
        response = requests.post(f"{MEASURE_API_BASE_URL}/set_fault_flag", json={'is_injected': is_injected_flag}, timeout=2)
        if response.status_code == 200:
            #print(f"Successfully set fault_injected_flag in measure.py to {is_injected_flag}")
            return True
        else:
            print(f"Failed to set fault_injected_flag in measure.py. Status: {response.status_code}, Msg: {response.text}")
    except requests.exceptions.RequestException as e:
        print(f"Error calling measure.py API to set fault flag: {e}")
    return False

@app.route('/api/insert/fault', methods=['POST'])
def inject_fault_api():
    # --- リクエストデータはリスト形式で複数の障害定義を受け取る ---
    fault_definitions = request.get_json() 
    if not isinstance(fault_definitions, list):
        return jsonify({'status': 'error', 'message': 'Request body must be a list of fault definitions.'}), 400

    results = [] # --- 各障害注入の結果を格納 ---
    any_fault_injected_successfully = False # 少なくとも1つの障害が成功したか

    # --- 最初の障害注入の前にフラグをTrueに設定 ---
    if fault_definitions: # 注入する障害が1つ以上ある場合のみフラグを立てる
        set_measure_fault_flag(True)

    for fault_data in fault_definitions:
        fault_type = fault_data.get('fault_type')
        
        target_node = fault_data.get('target_node')
        target_interface = fault_data.get('target_interface')
        target_link_str = fault_data.get('target_link')
        
        latency_ms = fault_data.get('latency_ms')
        jitter_ms = fault_data.get('jitter_ms')
        correlation_percent = fault_data.get('correlation_percent')
        
        bandwidth_rate_kbit = fault_data.get('bandwidth_rate_kbit')
        bandwidth_burst_bytes = fault_data.get('bandwidth_burst_bytes')
        bandwidth_latency_ms = fault_data.get('bandwidth_latency_ms')

        command_list = []
        target_display = ""
        current_message = ""
        current_status = "error"

        try:
            if fault_type == 'link_down' or fault_type == 'link_up':
                if not target_link_str or not target_interface:
                    current_message = 'Target link and interface must be selected/entered for link operations.'
                    results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message, 'target_display': target_link_str or 'N/A'})
                    continue # 次の障害定義へ
                
                node_to_act_on = target_node or target_link_str.split('|')[0]
                target_display = f"{fault_type} on link {target_link_str.replace('|','-')} interface {target_interface} of node {node_to_act_on}"
                action = "down" if fault_type == 'link_down' else "up"
                command_list = ["docker", "exec", node_to_act_on, "ip", "link", "set", target_interface, action]

            elif fault_type in ['node_stop', 'node_start', 'node_pause', 'node_unpause']:
                if not target_node:
                    current_message = 'Target node must be selected.'
                    results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message, 'target_display': 'N/A'})
                    continue
                target_display = f"node {target_node}"
                action = fault_type.split('_')[1] 
                command_list = ["docker", action, target_node]
            
            elif fault_type == 'add_latency':
                if not (target_node and target_interface and latency_ms):
                    current_message = 'Target Node, Target Interface, and Latency (ms) are required.'
                    results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message, 'target_display': f"{target_node or 'N/A'}/{target_interface or 'N/A'}"})
                    continue
                try:
                    lat_val = int(latency_ms); assert lat_val > 0
                except: current_message = f'Invalid Latency: {latency_ms}'; results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message, 'target_display':target_display}); continue

                target_display = f"latency ({latency_ms}ms) on {target_node}/{target_interface}"
                tc_cmd_parts = ["docker","exec",target_node,"tc","qdisc","add","dev",target_interface,"root","netem","delay",f"{latency_ms}ms"]
                if jitter_ms:
                    try: jit_val = int(jitter_ms); assert jit_val > 0; tc_cmd_parts.extend(["jitter", f"{jit_val}ms"])
                    except: app.logger.warning(f"Invalid jitter '{jitter_ms}', ignoring.")
                if correlation_percent:
                    try: corr_val = int(correlation_percent); assert 0 <= corr_val <= 100; tc_cmd_parts.extend(["correlation", f"{corr_val}%"])
                    except: app.logger.warning(f"Invalid correlation '{correlation_percent}', ignoring.")
                command_list = tc_cmd_parts
                current_message += f"Attempting to add latency on {target_node}/{target_interface}. "

            elif fault_type == 'limit_bandwidth':
                if not (target_node and target_interface and bandwidth_rate_kbit):
                    current_message = 'Target Node, Interface, and Rate (kbit) are required.'
                    results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message, 'target_display': f"{target_node or 'N/A'}/{target_interface or 'N/A'}"})
                    continue
                try: rate_val = int(bandwidth_rate_kbit); assert rate_val > 0
                except: current_message = f'Invalid Rate: {bandwidth_rate_kbit}'; results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message, 'target_display':target_display}); continue

                target_display = f"bandwidth limit ({bandwidth_rate_kbit}kbit) on {target_node}/{target_interface}"
                burst = bandwidth_burst_bytes or f"{int(bandwidth_rate_kbit) * 1000 // 8 // 10}"
                tbf_latency = bandwidth_latency_ms or "50ms"
                command_list = ["docker","exec",target_node,"tc","qdisc","add","dev",target_interface,"root","tbf", 
                                "rate",f"{bandwidth_rate_kbit}kbit","burst",str(burst),"latency",str(tbf_latency)]
                current_message += f"Attempting to limit bandwidth on {target_node}/{target_interface}. "

            elif fault_type == 'tc_clear':
                if not (target_node and target_interface):
                    current_message = 'Target Node and Interface are required for tc_clear.'
                    results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message, 'target_display': f"{target_node or 'N/A'}/{target_interface or 'N/A'}"})
                    continue
                target_display = f"tc rules on {target_node}/{target_interface}"
                command_list = ["docker", "exec", target_node, "tc", "qdisc", "del", "dev", target_interface, "root"]
                current_message += f"Attempting to clear tc qdisc on {target_node}/{target_interface}. "
            else:
                current_message = f'Unknown fault type: {fault_type}'
                results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message, 'target_display': 'N/A'})
                continue

            if command_list:
                stdout, stderr = run_command(command_list)
                if stderr and "file exists" in stderr.lower() and ("add" in command_list or "change" in command_list):
                    current_message += f'Executed, but qdisc might have already existed. Output: {stdout or stderr}'
                    current_status = 'warning'
                    any_fault_injected_successfully = True # 警告でも一応成功扱いにするか検討
                elif stderr and any(err_keyword in stderr.lower() for err_keyword in ["error", "failed", "no such", "cannot", "invalid", "unknown"]):
                    current_message += f'Failed. Error: {stderr}'
                    current_status = 'error'
                elif stdout is None and stderr is None and fault_type != 'tc_clear':
                    current_message += 'Command likely timed out or failed with no output.'
                    current_status = 'error'
                else:
                     current_message += f'Successfully executed. Output: {stdout or stderr}'
                     current_status = 'success'
                     any_fault_injected_successfully = True
            else:
                 current_message = 'Could not generate command.'
                 current_status = 'error'
        except Exception as e:
            current_message = f'Unexpected error: {str(e)}'
            current_status = 'error'
            app.logger.error(f"Inject fault API error for {fault_type}: {e}", exc_info=True)
        
        results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message.strip(), 'target_display': target_display})
    # --- ループ処理終わり ---

    # --- 全体の結果メッセージを生成 ---
    final_summary_message = f"Fault injection process completed. {len(results)} fault(s) attempted. "
    success_count = sum(1 for r in results if r['status'] == 'success' or r['status'] == 'warning')
    final_summary_message += f"{success_count} succeeded (or with warnings). "
    
    detailed_messages = [f"  - {r['fault_type']} on {r['target_display']}: {r['status'].upper()} - {r['message']}" for r in results]
    
    # 全体としてのステータス (一つでもエラーがあればエラー、そうでなければ成功)
    overall_status = 'error' if any(r['status'] == 'error' for r in results) else 'success'
    if success_count > 0 and overall_status == 'error': # 一部は成功したが全体ではエラー
        overall_status = 'warning' # または 'partial_success'のようなカスタムステータス

    # --- 障害注入が全く成功しなかった場合はフラグをFalseに戻すことを検討 ---
    # if not any_fault_injected_successfully and fault_definitions:
    #     set_measure_fault_flag(False)
    #     final_summary_message += " No faults were successfully injected, fault flag reset to False."
    # --- (今回はこのリセットロジックは入れないでおく) ---

    return jsonify({'status': overall_status, 'message': final_summary_message, 'details': results, 'detailed_messages_for_display': "\n".join(detailed_messages)})