from ceapp import app

from flask import request, jsonify
import subprocess
import json
import re
import os
import ipaddress
import requests 
import threading # 時間制限付きループ解除のため

# (run_command, get_clab_containers, get_container_interface_details は変更なしと仮定)
# (get_detailed_links_from_networks は詳細なリンク情報を返すものを想定)
def run_command(command_list, timeout=10):
    """コマンドを実行し、標準出力を返す"""
    try:
        #print(f"Executing command: {' '.join(command_list)}") # 実行コマンドのログ出力
        result = subprocess.run(command_list, capture_output=True, text=True, check=True, timeout=timeout)
        #print(f"Stdout: {result.stdout.strip()}") # 標準出力のログ出力
        if result.stderr: # 標準エラーも出力があればログに残す
            print(f"Stderr: {result.stderr.strip()}")
        return result.stdout.strip(), result.stderr.strip() if result.stderr else ""
    except subprocess.CalledProcessError as e:
        print(f"Error running command {' '.join(command_list)}: {e}")
        #print(f"Stdout (if any): {e.stdout.strip()}") # エラー時の標準出力
        print(f"Stderr: {e.stderr.strip()}") # エラー時の標準エラー
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
        #print(f"Detected containers: {containers}")
        return containers
    if stderr and "Cannot connect to the Docker daemon" in stderr: # Dockerデーモン接続エラー
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
    cmd = ["docker", "exec", container_name, "ip", "-j", "addr"]
    stdout, stderr = run_command(cmd)
    interfaces = []
    if stdout:
        try:
            data = json.loads(stdout)
            for iface_data in data:
                if iface_data.get("link_type")=="loopback" or not iface_data.get("operstate")=="UP": continue
                if_name, mac = iface_data.get("ifname"), iface_data.get("address")
                ip_infos = [f"{a['local']}/{a['prefixlen']}" for a in iface_data.get("addr_info",[]) if a.get("family")=="inet"]
                if if_name and ip_infos: interfaces.append({"name":if_name, "mac":mac, "ips_cidr":ip_infos})
        except Exception as e: print(f"Error parsing ip addr JSON for {container_name}: {e}. Output: {stdout[:200]}")
    elif stderr: print(f"Error getting IF details for {container_name}: {stderr}")
    else: print(f"No IF details output for {container_name}")
    return interfaces

def get_detailed_links_from_networks(containers):
    """
    コンテナ間の接続（リンク）情報と、そのリンクで使用されているIPアドレスを推定する。
    """
    all_interfaces_details_map = {}
    for container_name in containers:
        details = get_container_interface_details(container_name)
        if details:
            all_interfaces_details_map[container_name] = details
    
    subnet_connectivity_map = {} 
    for container_name, ifaces_list in all_interfaces_details_map.items():
        for iface_detail in ifaces_list: 
            for ip_cidr_str in iface_detail["ips_cidr"]: 
                try:
                    ip_interface_obj = ipaddress.ip_interface(ip_cidr_str)
                    ip_network_obj = ip_interface_obj.network            
                    if ip_network_obj.is_link_local or ip_network_obj.is_loopback:
                        continue
                    subnet_str = str(ip_network_obj)
                    if subnet_str not in subnet_connectivity_map:
                        subnet_connectivity_map[subnet_str] = []
                    subnet_connectivity_map[subnet_str].append({
                        "container": container_name, 
                        "if_name": iface_detail["name"],
                        "ip_cidr": ip_cidr_str,
                        "ip_address": str(ip_interface_obj.ip)
                    })
                except ValueError as e:
                    print(f"Invalid IP/CIDR format '{ip_cidr_str}' for {container_name}/{iface_detail['name']}: {e}")
                    continue
    
    detailed_links = []
    processed_pairs_on_subnet = set()

    for subnet_str, connected_entities_list in subnet_connectivity_map.items():
        unique_containers_in_subnet = sorted(list(set(entity["container"] for entity in connected_entities_list)))
        if len(unique_containers_in_subnet) == 2:
            node1_name, node2_name = unique_containers_in_subnet[0], unique_containers_in_subnet[1]
            pair_subnet_key = tuple(sorted((node1_name, node2_name)) + [subnet_str])
            if pair_subnet_key in processed_pairs_on_subnet:
                continue
            processed_pairs_on_subnet.add(pair_subnet_key)

            node1_info = next((e for e in connected_entities_list if e["container"] == node1_name), None)
            node2_info = next((e for e in connected_entities_list if e["container"] == node2_name), None)

            if node1_info and node2_info:
                detailed_links.append({
                    'nodes': [node1_name, node2_name],
                    'shared_subnet': subnet_str,
                    'interface_details': {
                        node1_name: {'if_name': node1_info['if_name'], 'ip_cidr': node1_info['ip_cidr'], 'ip_address': node1_info['ip_address']},
                        node2_name: {'if_name': node2_info['if_name'], 'ip_cidr': node2_info['ip_cidr'], 'ip_address': node2_info['ip_address']}
                    }
                })
    #print(f"Detected detailed links: {json.dumps(detailed_links, indent=2)}") # デバッグ時はコメント解除
    return detailed_links


@app.route('/api/insert/topology', methods=['GET'])
def get_topology():
    containers = get_clab_containers()
    detailed_links = get_detailed_links_from_networks(containers)
    simple_links = list(set(tuple(sorted(link_info['nodes'])) for link_info in detailed_links))
    interfaces_by_container = {c: [if_d['name'] for if_d in get_container_interface_details(c)] for c in containers}
    return jsonify({'containers': containers, 'links': simple_links, 'detailed_links': detailed_links, 'interfaces_by_container': interfaces_by_container})

MEASURE_API_BASE_URL = "http://localhost:5000/api/measure" 

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
    fault_definitions = request.get_json() 
    if not isinstance(fault_definitions, list):
        return jsonify({'status': 'error', 'message': 'Request body must be a list of fault definitions.'}), 400

    results = [] 
    any_fault_injected_successfully = False 

    if fault_definitions: 
        set_measure_fault_flag(True)

    _current_detailed_links_for_loop = None 

    for fault_data in fault_definitions: 
        fault_type = fault_data.get('fault_type')
        
        target_node = fault_data.get('target_node')
        target_interface = fault_data.get('target_interface')
        target_link_str = "" #fault_data.get('target_link') #削除
        
        latency_ms = fault_data.get('latency_ms')
        jitter_ms = fault_data.get('jitter_ms')
        correlation_percent = fault_data.get('correlation_percent')
        
        bandwidth_rate_kbit = fault_data.get('bandwidth_rate_kbit')
        bandwidth_burst_bytes = fault_data.get('bandwidth_burst_bytes')
        bandwidth_latency_ms = fault_data.get('bandwidth_latency_ms')

        loop_node1_name = fault_data.get('loop_node1')
        loop_node2_name = fault_data.get('loop_node2')
        loop_dummy_dest_ip = fault_data.get('loop_dummy_dest_ip', "192.168.7.2/32") 
        loop_duration_sec = fault_data.get('loop_duration_sec', 10) 
        loop_ping_target_ip = fault_data.get('loop_ping_target_ip')
        loop_ping_count = fault_data.get('loop_ping_count', 5) 

        command_list_node1 = [] 
        command_list_node2 = []
        ping_command_during_loop = [] 
        additional_commands_after_delay = [] 
        target_display = ""
        current_message = "" 
        current_status = "error" 

        if fault_type == 'routing_loop_timed' and _current_detailed_links_for_loop is None: 
            _current_containers_for_loop = get_clab_containers() 
            _current_detailed_links_for_loop = get_detailed_links_from_networks(_current_containers_for_loop if _current_containers_for_loop else [])

        try:
            if fault_type == 'link_down' or fault_type == 'link_up':
                if not target_link_str or not target_interface:
                    current_message = 'Target link and interface must be selected/entered for link operations.'
                    results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message, 'target_display': target_link_str or 'N/A'})
                    continue 
                
                node_to_act_on = target_node or target_link_str.split('|')[0]
                target_display = f"{fault_type} on link {target_link_str.replace('|','-')} interface {target_interface} of node {node_to_act_on}"
                action = "down" if fault_type == 'link_down' else "up"
                command_list_node1 = ["docker", "exec", node_to_act_on, "ip", "link", "set", target_interface, action]

            elif fault_type in ['node_stop', 'node_start', 'node_pause', 'node_unpause']:
                if not target_node:
                    current_message = 'Target node must be selected.'
                    results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message, 'target_display': 'N/A'})
                    continue
                target_display = f"node {target_node}"
                action = fault_type.split('_')[1] 
                command_list_node1 = ["docker", action, target_node]
            
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
                command_list_node1 = tc_cmd_parts
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
                command_list_node1 = ["docker","exec",target_node,"tc","qdisc","add","dev",target_interface,"root","tbf", 
                                "rate",f"{bandwidth_rate_kbit}kbit","burst",str(burst),"latency",str(tbf_latency)]
                current_message += f"Attempting to limit bandwidth on {target_node}/{target_interface}. "

            elif fault_type == 'tc_clear':
                if not (target_node and target_interface):
                    current_message = 'Target Node and Interface are required for tc_clear.'
                    results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message, 'target_display': f"{target_node or 'N/A'}/{target_interface or 'N/A'}"})
                    continue
                target_display = f"tc rules on {target_node}/{target_interface}"
                command_list_node1 = ["docker", "exec", target_node, "tc", "qdisc", "del", "dev", target_interface, "root"]
                current_message += f"Attempting to clear tc qdisc on {target_node}/{target_interface}. "
            
            elif fault_type == 'routing_loop_timed':
                if not (loop_node1_name and loop_node2_name and loop_dummy_dest_ip and loop_duration_sec):
                    current_message = 'Node1, Node2, Dummy Destination IP, and Duration are required for timed routing loop.'
                    results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message, 'target_display': f"{loop_node1_name or 'N/A'}-{loop_node2_name or 'N/A'}"})
                    continue
                if loop_node1_name == loop_node2_name:
                    current_message = 'Node1 and Node2 for routing loop must be different.'
                    results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message, 'target_display': loop_node1_name})
                    continue
                
                duration_val_for_loop = 10 
                try:
                    duration_val_for_loop = int(loop_duration_sec)
                    if duration_val_for_loop <= 0: raise ValueError("Duration must be positive.")
                except ValueError:
                    current_message = f'Invalid Loop Duration value: {loop_duration_sec}. Must be a positive integer.'
                    results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message, 'target_display': target_display})
                    continue

                target_display = f"timed routing loop ({duration_val_for_loop}s) between {loop_node1_name} and {loop_node2_name} for dummy dest {loop_dummy_dest_ip}"

                link_info_for_loop = None
                if _current_detailed_links_for_loop: 
                    for link in _current_detailed_links_for_loop: 
                        nodes_in_link = sorted(link['nodes'])
                        selected_nodes_sorted = sorted([loop_node1_name, loop_node2_name])
                        if nodes_in_link == selected_nodes_sorted:
                            link_info_for_loop = link
                            break
                
                if not link_info_for_loop:
                    current_message = f'No direct link found between {loop_node1_name} and {loop_node2_name} in the detected topology. Cannot determine next hops for loop.'
                    results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message, 'target_display': target_display})
                    continue

                node1_link_details = link_info_for_loop['interface_details'].get(loop_node1_name)
                node2_link_details = link_info_for_loop['interface_details'].get(loop_node2_name)

                if not (node1_link_details and node2_link_details and node1_link_details.get('ip_address') and node2_link_details.get('ip_address')):
                    current_message = f'Could not retrieve valid interface IP details for the link between {loop_node1_name} and {loop_node2_name}.'
                    results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message, 'target_display': target_display})
                    continue

                next_hop_on_node1_to_node2 = node2_link_details['ip_address']
                next_hop_on_node2_to_node1 = node1_link_details['ip_address']

                command_list_node1 = ["docker", "exec", loop_node1_name, "ip", "route", "add", loop_dummy_dest_ip, "via", next_hop_on_node1_to_node2]
                command_list_node2 = ["docker", "exec", loop_node2_name, "ip", "route", "add", loop_dummy_dest_ip, "via", next_hop_on_node2_to_node1]
                
                del_command_node1 = ["docker", "exec", loop_node1_name, "ip", "route", "del", loop_dummy_dest_ip, "via", next_hop_on_node1_to_node2]
                del_command_node2 = ["docker", "exec", loop_node2_name, "ip", "route", "del", loop_dummy_dest_ip, "via", next_hop_on_node2_to_node1]
                additional_commands_after_delay.append(del_command_node1)
                additional_commands_after_delay.append(del_command_node2)

                current_message += f"Setting up timed loop. Next hops: {loop_node1_name}->{next_hop_on_node1_to_node2}, {loop_node2_name}->{next_hop_on_node2_to_node1}. "

                if loop_ping_target_ip and loop_ping_count:
                    try:
                        ping_c = int(loop_ping_count)
                        if ping_c > 0:
                            ping_command_during_loop = ["docker", "exec", "-it", loop_node1_name, "ping", "-c", str(ping_c), "-i", "0.2", "-W", "1", loop_ping_target_ip]
                            current_message += f"Will also attempt to ping {loop_ping_target_ip} ({ping_c} times) from {loop_node1_name} during the loop. "
                    except ValueError:
                        app.logger.warning(f"Invalid loop_ping_count value '{loop_ping_count}', skipping ping during loop.")
            else:
                current_message = f'Unknown fault type: {fault_type}'
                results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message, 'target_display': 'N/A'})
                continue

            cmds_to_run_now = []
            if command_list_node1: cmds_to_run_now.append(command_list_node1)
            if command_list_node2: cmds_to_run_now.append(command_list_node2)
            if ping_command_during_loop and fault_type == 'routing_loop_timed': # ping コマンドをリストの最後に追加
                cmds_to_run_now.append(ping_command_during_loop)
            
            if cmds_to_run_now:
                all_step_successful = True
                for cmd_to_run in cmds_to_run_now:
                    stdout, stderr = run_command(cmd_to_run)
                    node_name_for_log = cmd_to_run[2] 
                    if stdout: current_message += f" stdout({node_name_for_log}): {stdout}."
                    if stderr: current_message += f" stderr({node_name_for_log}): {stderr}."
                    
                    is_ping_cmd = cmd_to_run[3] == "ping" if len(cmd_to_run) > 3 else False

                    if stderr and any(err_keyword in stderr.lower() for err_keyword in ["error", "failed", "no such", "cannot", "invalid"]):
                        if not is_ping_cmd: 
                            all_step_successful = False
                            break 
                        else: 
                            current_message += f" (Ping to {loop_ping_target_ip} might have failed or timed out from {node_name_for_log})."

                    elif stdout is None and stderr is None and fault_type != 'tc_clear' and not is_ping_cmd:
                        all_step_successful = False
                        current_message += f" Command on {node_name_for_log} failed with no output."
                        break
                
                if all_step_successful:
                    current_status = 'success'
                    any_fault_injected_successfully = True

                    if fault_type == 'routing_loop_timed' and additional_commands_after_delay:
                        def execute_delayed_commands(commands_to_del_list, duration):
                            print(f"Executing delayed cleanup for routing loop after {duration} seconds...")
                            for cmd_del in commands_to_del_list:
                                print(f"  Deleting route: {' '.join(cmd_del)}")
                                del_stdout, del_err = run_command(cmd_del)
                                if del_err:
                                    print(f"  Error deleting route: {del_err}. Stdout: {del_stdout}")
                                elif del_stdout:
                                    print(f"  Delete route stdout: {del_stdout}")
                            print("Delayed cleanup finished.")
                        
                        loop_duration_from_data = int(fault_data.get('loop_duration_sec', 10)) 
                        timer = threading.Timer(loop_duration_from_data, execute_delayed_commands, args=[list(additional_commands_after_delay), loop_duration_from_data])
                        timer.start()
                        current_message += f" Loop cleanup scheduled in {loop_duration_from_data} seconds."
                else: 
                    current_status = 'error'
                    if not ("Ping to" in current_message): 
                        current_message += ' One or more setup commands failed.'
            elif not command_list_node1 and not command_list_node2:
                 current_message = 'Could not generate command.'
                 current_status = 'error'

        except Exception as e:
            current_message = f'Unexpected error processing fault {fault_type}: {str(e)}'
            current_status = 'error'
            app.logger.error(f"Inject fault API error for {fault_type}: {e}", exc_info=True)
        
        results.append({'fault_type': fault_type, 'status': current_status, 'message': current_message.strip(), 'target_display': target_display})

    final_summary_message = f"Fault injection process completed. {len(results)} fault(s) attempted. "
    success_count = sum(1 for r in results if r['status'] == 'success' or r['status'] == 'warning')
    final_summary_message += f"{success_count} succeeded (or with warnings). "
    
    detailed_messages_for_display_list = [f"  - {r['fault_type']} on {r['target_display']}: {r['status'].upper()} - {r['message']}" for r in results]
    
    overall_status = 'error' if any(r['status'] == 'error' for r in results) else 'success'
    if success_count > 0 and overall_status == 'error': 
        overall_status = 'warning' 
    
    return jsonify({'status': overall_status, 'message': final_summary_message, 'details': results, 'detailed_messages_for_display': "\n".join(detailed_messages_for_display_list)})