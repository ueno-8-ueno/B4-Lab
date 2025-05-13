from ceapp import app

from flask import Flask, render_template, request, flash, redirect, url_for
# from utils import get_clab_containers, get_links_from_networks, run_command # utils.pyを使う場合
import subprocess # utilsを使わない場合は直接subprocessを呼ぶ
import json
import re
import os

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
    stdout, stderr = run_command(["docker", "ps", "--format", "{{.Names}}", "--filter", "name=r"])
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

    # ネットワーク情報を事前に取得してキャッシュ
    relevant_networks = set()
    for container in containers:
        nets = get_container_networks(container)
        container_networks_cache[container] = nets
        relevant_networks.update(n for n in nets if n != 'bridge') # bridgeは無視

    network_info_cache = {}
    for net_name in relevant_networks:
         network_info_cache[net_name] = get_network_info(net_name)

    # キャッシュを使ってリンクを推定
    checked_pairs = set()
    for c1 in containers:
        for net_name in container_networks_cache.get(c1, []):
            if net_name == 'bridge' or net_name not in network_info_cache:
                continue

            net_info = network_info_cache[net_name]
            if net_info and 'Containers' in net_info:
                 # このネットワークにいる他のコンテナを探す
                for c2 in containers:
                    if c1 == c2: continue
                    # c2 もこのネットワークにいるか？ (IDで確認するのが本当は良い)
                    if net_name in container_networks_cache.get(c2, []):
                        pair = tuple(sorted((c1, c2)))
                        if pair not in checked_pairs:
                             links.add(pair)
                             checked_pairs.add(pair)

    link_list = [list(link) for link in links]
    print(f"Detected links: {link_list}")
    return link_list

# --- Flask App ---
#app = Flask(__name__)
app.secret_key = os.urandom(24) # Flashメッセージ用に必要

@app.route('/insert')
def insert():
    containers = get_clab_containers()
    links = get_links_from_networks(containers) # コンテナリストからリンクを推定
    return render_template('insert.html', containers=containers, links=links)

@app.route('/inject', methods=['POST'])
def inject_fault():
    fault_type = request.form.get('fault_type')
    target_node = request.form.get('target_node')
    target_link_str = request.form.get('target_link')
    target_interface = request.form.get('target_interface_link', 'eth1') # デフォルト'eth1'

    command_list = []
    target_display = ""

    try:
        if fault_type == 'link_down' or fault_type == 'link_up':
            if not target_link_str:
                flash('Target link must be selected.', 'error')
                return redirect(url_for('index'))
            node1, node2 = target_link_str.split('|')
            target_display = f"link between {node1} and {node2} (interface: {target_interface})"
            # 注意: 両方のコンテナでインターフェースを操作する必要があるかもしれない
            # ここでは片側(node1)だけ操作する簡易実装
            action = "down" if fault_type == 'link_down' else "up"
            command_list = ["docker", "exec", node1, "ip", "link", "set", target_interface, action]

        elif fault_type in ['node_stop', 'node_start', 'node_pause', 'node_unpause']:
            if not target_node:
                flash('Target node must be selected.', 'error')
                return redirect(url_for('index'))
            target_display = f"node {target_node}"
            action = fault_type.split('_')[1] # stop, start, pause, unpause
            command_list = ["docker", action, target_node]

        # --- 他の障害タイプのコマンド生成ロジックをここに追加 ---
        # elif fault_type == 'cpu_stress':
        #     duration = request.form.get('cpu_duration', '60')
        #     target_display = f"node {target_node} (CPU Stress)"
        #     command_list = ["docker", "exec", target_node, "stress-ng", "--cpu", "1", "--cpu-load", "100", "--timeout", f"{duration}s"]
        # elif fault_type == 'bw_limit':
        #      rate = request.form.get('bw_rate', '1mbit')
        #      bw_interface = request.form.get('target_interface_bw')
        #      if not bw_interface:
        #           flash('Target interface for bandwidth limit is required.', 'error')
        #           return redirect(url_for('index'))
        #      target_display = f"node {target_node} interface {bw_interface} (BW Limit)"
        #      # Apply limit command (example using TBF)
        #      command_list = ["docker", "exec", target_node, "tc", "qdisc", "add", "dev", bw_interface, "root", "tbf", "rate", rate, "burst", "32kbit", "latency", "400ms"]
        #      # Need a corresponding 'delete' command for recovery

        else:
            flash(f'Unknown fault type: {fault_type}', 'error')
            return redirect(url_for('index'))

        # コマンド実行
        if command_list:
            stdout, stderr = run_command(command_list)
            if stderr is not None and "Error" in stderr: # 簡単なエラーチェック
                flash(f'Failed to inject {fault_type} on {target_display}. Error: {stderr}', 'error')
            elif stdout is not None or stderr is not None: # 成功または警告
                 flash(f'Successfully executed {fault_type} on {target_display}. Output: {stdout or stderr}', 'success')
            else: # run_command内でエラーがprintされているはず
                 flash(f'Failed to inject {fault_type} on {target_display}. Check console logs.', 'error')

        else:
             flash('Could not generate command for the selected fault.', 'error')

    except Exception as e:
        flash(f'An unexpected error occurred: {str(e)}', 'error')

    return redirect(url_for('index'))