from ceapp import app

from flask import request, jsonify # jsonify をインポート
# from utils import get_clab_containers, get_links_from_networks, run_command # utils.pyを使う場合
import subprocess # utilsを使わない場合は直接subprocessを呼ぶ
import json
import re
import os

# app.secret_key の行は __init__.py で設定するため削除

# --- 関数群 (run_command, get_clab_containers, get_container_networks, get_network_info, get_links_from_networks) は変更なし ---
def run_command(command_list, timeout=10):
    """コマンドを実行し、標準出力を返す"""
    try:
        print(f"Executing command: {' '.join(command_list)}") # 実行コマンドのログ出力
        result = subprocess.run(command_list, capture_output=True, text=True, check=True, timeout=timeout)
        print(f"Stdout: {result.stdout.strip()}")
        print(f"Stderr: {result.stderr.strip()}")
        return result.stdout.strip(), result.stderr.strip()
    except subprocess.CalledProcessError as e:
        print(f"Error running command {' '.join(command_list)}: {e}")
        print(f"Stderr: {e.stderr.strip()}")
        return None, e.stderr.strip()
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
        print(f"Detected containers: {containers}")
        return containers
    print(f"Failed to get containers: {stderr}")
    return []

def get_container_networks(container_name):
    """指定されたコンテナが接続しているDockerネットワーク名を取得"""
    cmd = ["docker", "inspect", container_name, "--format", "{{json .NetworkSettings.Networks}}"]
    stdout, stderr = run_command(cmd)
    if stdout:
        try:
            networks = json.loads(stdout)
            return list(networks.keys())
        except json.JSONDecodeError:
            print(f"Error decoding network JSON for {container_name}: {stderr}")
    return []

def get_network_info(network_name):
    """指定されたDockerネットワークの詳細情報を取得"""
    cmd = ["docker", "network", "inspect", network_name, "--format", "{{json .}}"]
    stdout, stderr = run_command(cmd)
    if stdout:
        try:
            network_data = json.loads(stdout)
            if isinstance(network_data, list):
                 return network_data[0] if network_data else None
            return network_data
        except json.JSONDecodeError:
            print(f"Error decoding network JSON for {network_name}: {stderr}")
    return None

def get_links_from_networks(containers):
    """コンテナ間の接続（リンク）情報を推定する (簡易版)"""
    links = set()
    container_networks_cache = {}

    relevant_networks = set()
    for container in containers:
        nets = get_container_networks(container)
        container_networks_cache[container] = nets
        relevant_networks.update(n for n in nets if n != 'bridge')

    network_info_cache = {}
    for net_name in relevant_networks:
         network_info_cache[net_name] = get_network_info(net_name)

    checked_pairs = set()
    for c1 in containers:
        for net_name in container_networks_cache.get(c1, []):
            if net_name == 'bridge' or net_name not in network_info_cache:
                continue

            net_info = network_info_cache[net_name]
            if net_info and 'Containers' in net_info:
                for c2 in containers:
                    if c1 == c2: continue
                    if net_name in container_networks_cache.get(c2, []):
                        pair = tuple(sorted((c1, c2)))
                        if pair not in checked_pairs:
                             links.add(pair)
                             checked_pairs.add(pair)

    link_list = [list(link) for link in links]
    print(f"Detected links: {link_list}")
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