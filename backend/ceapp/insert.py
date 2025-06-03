from ceapp import app

from flask import request, jsonify # jsonify をインポート
import subprocess
import json
import re
import os
import ipaddress #  IPアドレス/ネットワーク操作のために追加

# app.secret_key の行は __init__.py で設定するため削除

def run_command(command_list, timeout=10):
    """コマンドを実行し、標準出力を返す"""
    try:
        print(f"Executing command: {' '.join(command_list)}") # 実行コマンドのログ出力
        # check=True のままでも、CalledProcessErrorで stderr を補足できる
        result = subprocess.run(command_list, capture_output=True, text=True, check=True, timeout=timeout)
        print(f"Stdout: {result.stdout.strip()}")
        if result.stderr: # 標準エラーも出力があればログに残す
            print(f"Stderr: {result.stderr.strip()}")
        return result.stdout.strip(), result.stderr.strip() if result.stderr else ""
    except subprocess.CalledProcessError as e:
        print(f"Error running command {' '.join(command_list)}: {e}")
        print(f"Stdout (if any): {e.stdout.strip()}")
        print(f"Stderr: {e.stderr.strip()}")
        # stdout もエラーメッセージを含むことがあるので、両方返すことを検討
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
    # Docker ps コマンドが失敗した場合 (Dockerデーモンが動いていない等) も考慮
    stdout, stderr = run_command(["docker", "ps", "--format", "{{.Names}}", "--filter", "name=clab-"])
    if stdout:
        containers = stdout.splitlines()
        # 空行や不正な行を除外することが望ましい場合がある
        containers = [c.strip() for c in containers if c.strip()]
        print(f"Detected containers: {containers}")
        return containers
    # stderr にエラーメッセージがある場合と、単に該当コンテナがない場合を区別
    if stderr and "Cannot connect to the Docker daemon" in stderr:
        print(f"Failed to connect to Docker daemon: {stderr}")
    elif stderr:
        print(f"Failed to get containers, stderr: {stderr}")
    else:
        print("No clab containers found.")
    return []

def get_container_interface_details(container_name):
    """
    指定されたコンテナのインターフェース詳細 (名前, IP/CIDR, MAC) を取得。
    docker exec <container> ip -j addr を使用。
    """
    # ipコマンドがコンテナ内に存在しない場合も考慮
    cmd = ["docker", "exec", container_name, "ip", "-j", "addr"]
    stdout, stderr = run_command(cmd)
    interfaces = []

    if stdout:
        try:
            data = json.loads(stdout)
            for iface_data in data:
                # ループバックインターフェースやIPアドレスを持たないインターフェースはスキップ
                if iface_data.get("link_type") == "loopback" or not iface_data.get("operstate") == "UP":
                    continue

                if_name = iface_data.get("ifname")
                mac_address = iface_data.get("address") # MACアドレス

                ip_infos = []
                for addr_info in iface_data.get("addr_info", []):
                    # IPv4アドレスのみを対象とする (family "inet")
                    if addr_info.get("family") == "inet":
                        ip_cidr = f"{addr_info['local']}/{addr_info['prefixlen']}"
                        ip_infos.append(ip_cidr)
                
                # IPアドレスを持つインターフェースのみリストに追加
                if if_name and ip_infos:
                    interfaces.append({
                        "name": if_name,
                        "mac": mac_address,
                        "ips": ip_infos
                    })
        except json.JSONDecodeError:
            print(f"Error decoding 'ip addr' JSON for {container_name}. Output: {stdout[:200]}... Stderr: {stderr}")
        except KeyError as e:
            print(f"KeyError parsing 'ip addr' JSON for {container_name}: {e}")
    elif stderr: # stdoutがなくてもstderrにエラー情報がある場合
        print(f"Failed to get interface details for {container_name} using 'ip addr'. Stderr: {stderr}")
    else: # stdoutもstderrも空だがコマンド実行に失敗したケース(run_command内でログ出力済みのはず)
        print(f"No output from 'ip addr' for {container_name}, and no explicit error captured.")

    return interfaces

def get_links_from_networks(containers):
    """
    コンテナ間の接続（リンク）情報をIPサブネットベースで推定する。
    各コンテナのインターフェース情報を基に、同じサブネットを共有するコンテナペアをリンクと見なす。
    """
    all_interfaces_details = {}
    for container_name in containers:
        details = get_container_interface_details(container_name)
        if details: # インターフェース詳細が取得できたコンテナのみを対象
            all_interfaces_details[container_name] = details
    
    # サブネットをキーとし、そのサブネットに属する(コンテナ名, インターフェース名, IPアドレスオブジェクト)のリストを値とする辞書
    subnet_map = {} 

    for container_name, ifaces in all_interfaces_details.items():
        for iface in ifaces:
            for ip_cidr_str in iface["ips"]:
                try:
                    # ip_interfaceオブジェクト (例: '192.168.1.5/24')
                    ip_interface = ipaddress.ip_interface(ip_cidr_str)
                    # ip_networkオブジェクト (例: '192.168.1.0/24')
                    ip_network = ip_interface.network 
                    
                    # リンクローカルアドレス(169.254.0.0/16)やループバック(127.0.0.0/8)は除外することが多い
                    if ip_network.is_link_local or ip_network.is_loopback:
                        continue
                        
                    if ip_network not in subnet_map:
                        subnet_map[ip_network] = []
                    
                    subnet_map[ip_network].append({
                        "container": container_name, 
                        "interface_name": iface["name"], # どのインターフェースか
                        "ip_object": ip_interface.ip     # IPアドレスオブジェクト
                    })
                except ValueError as e:
                    # 不正なIP/CIDRフォーマットの場合のログ
                    print(f"Invalid IP/CIDR format '{ip_cidr_str}' for {container_name}/{iface['name']}: {e}")
                    continue
    
    links = set()
    for subnet, connected_entities in subnet_map.items():
        # このサブネットに接続されているユニークなコンテナ名のリスト
        containers_in_subnet = sorted(list(set(entity["container"] for entity in connected_entities)))

        # このサブネットにちょうど2つの異なるコンテナが接続されていれば、
        # それらをP2Pリンクと見なす (Containerlabの一般的な構成を想定)
        if len(containers_in_subnet) == 2:
            c1, c2 = containers_in_subnet[0], containers_in_subnet[1]
            link_pair = tuple(sorted((c1, c2))) # コンテナ名のペアをソートしてタプル化
            links.add(link_pair)
        # elif len(containers_in_subnet) > 2:
            # 3つ以上のコンテナが同じサブネットにいる場合（例：共通のブリッジ）
            # これらをどう扱うかは設計次第。ここではP2Pリンクのみを検出対象とする。
            # print(f"Subnet {subnet} is shared by more than 2 containers: {containers_in_subnet}. Not treated as a direct P2P link in this context.")

    link_list = [list(link) for link in links]
    print(f"Detected links (IP subnet based): {link_list}")
    return link_list


# --- API Routes ---
@app.route('/api/insert/topology', methods=['GET'])
def get_topology():
    containers = get_clab_containers()
    links = get_links_from_networks(containers)
    return jsonify({'containers': containers, 'links': links})

@app.route('/api/insert/fault', methods=['POST'])
def inject_fault_api():
    data = request.get_json()
    fault_type = data.get('fault_type')
    target_node = data.get('target_node')
    target_link_str = data.get('target_link')
    target_interface = data.get('target_interface', 'eth1') # デフォルト'eth1'

    command_list = []
    target_display = ""
    message = ""
    status = "error" # Default to error

    try:
        if fault_type == 'link_down' or fault_type == 'link_up':
            if not target_link_str:
                return jsonify({'status': 'error', 'message': 'Target link must be selected.'})
            
            node1, node2 = target_link_str.split('|') # Reactから "node1|node2" の形式で来る想定
            target_display = f"link between {node1} and {node2} (interface: {target_interface})"
            action = "down" if fault_type == 'link_down' else "up"
            command_list = ["docker", "exec", node1, "ip", "link", "set", target_interface, action]

        elif fault_type in ['node_stop', 'node_start', 'node_pause', 'node_unpause']:
            if not target_node:
                return jsonify({'status': 'error', 'message': 'Target node must be selected.'})
            target_display = f"node {target_node}"
            action = fault_type.split('_')[1] 
            command_list = ["docker", action, target_node]
        
        # --- 他の障害タイプのロジック ---
        # elif fault_type == 'cpu_stress':
        #     duration = data.get('cpu_duration', '60')
        #     target_display = f"node {target_node} (CPU Stress)"
        #     command_list = ["docker", "exec", target_node, "stress-ng", "--cpu", "1", "--cpu-load", "100", "--timeout", f"{duration}s"]
        # elif fault_type == 'bw_limit':
        #      rate = data.get('bw_rate', '1mbit')
        #      bw_interface = data.get('target_interface_bw')
        #      if not bw_interface:
        #           return jsonify({'status': 'error', 'message': 'Target interface for bandwidth limit is required.'})
        #      target_display = f"node {target_node} interface {bw_interface} (BW Limit)"
        #      command_list = ["docker", "exec", target_node, "tc", "qdisc", "add", "dev", bw_interface, "root", "tbf", "rate", rate, "burst", "32kbit", "latency", "400ms"]

        else:
            return jsonify({'status': 'error', 'message': f'Unknown fault type: {fault_type}'})

        if command_list:
            stdout, stderr = run_command(command_list)
            if stderr is not None and "Error" in stderr:
                message = f'Failed to inject {fault_type} on {target_display}. Error: {stderr}'
                status = 'error'
            elif stdout is not None or stderr is not None:
                 message = f'Successfully executed {fault_type} on {target_display}. Output: {stdout or stderr}'
                 status = 'success'
            else:
                 message = f'Failed to inject {fault_type} on {target_display}. Check console logs.'
                 status = 'error'
        else:
             message = 'Could not generate command for the selected fault.'
             status = 'error'

    except Exception as e:
        message = f'An unexpected error occurred: {str(e)}'
        status = 'error'

    return jsonify({'status': status, 'message': message})