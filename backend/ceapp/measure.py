import subprocess
import re
import datetime
import csv
import time
import os
import json
import threading

from ceapp import app
from flask import request, jsonify

# --- 設定項目 (デフォルト値) ---
CLIENT_CONTAINER_NAME = "clab-ospf-pc1"
SERVER_CONTAINER_NAME = "clab-ospf-pc2"
SERVER_IP = "192.168.12.10"
MEASUREMENT_INTERVAL_SEC = 1
PING_COUNT = 10
IPERF_DURATION_SEC = 1
OUTPUT_CSV_FILE = "../../result.csv"
# --- 設定項目終わり ---

# --- グローバル変数 ---
loop_thread = None
stop_event = threading.Event()
iperf_server_started_flag = False
fault_injected_flag = False 
fault_flag_lock = threading.Lock() # フラグ操作の排他制御用ロック


"""
docker execコマンドを実行するための関数.
dockerコンテナ名と実行するコマンドリストを受け取り, 任意のオプションを加えて実行する.
"""
def run_clab_command(container_name, command_list, task_name="Unnamed Task", timeout_override=None, check_return_code=True):
    cmd = ["docker", "exec", container_name] + command_list
    timeout_val = timeout_override if timeout_override is not None else 15
    #print(f"[{task_name}] Executing: {' '.join(cmd)} with timeout {timeout_val}s")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=timeout_val)
        #if result.stdout: print(f"[{task_name}] Stdout: {result.stdout.strip()[:500]}...")
        if result.stderr: print(f"[{task_name}] Stderr: {result.stderr.strip()[:500]}...")
        if check_return_code and result.returncode != 0:
            print(f"[{task_name}] Error: Command failed with code {result.returncode}")
            if "iperf3 -s" in " ".join(command_list) and "Address already in use" in result.stderr:
                print(f"[{task_name}] Note: iperf3 server might be already running or port is in use.")
                return result.stderr
            return None
        if result.returncode == 0: return result.stdout
        else:
            if result.stdout and "error" in result.stdout.lower(): return result.stdout
            if result.stderr: return result.stderr
            return None
    except subprocess.TimeoutExpired:
        print(f"[{task_name}] Timeout ({timeout_val}s) expired for command: {' '.join(command_list)}")
        return None
    except FileNotFoundError:
        print(f"[{task_name}] Error: 'docker' command not found.")
        return None
    except Exception as e:
        print(f"[{task_name}] An unexpected error: {e}")
        return None


"""
pingの標準出力を解析してRTT avgとロス率を抽出するための関数.
"""
def parse_ping_output(ping_output):
    rtt_avg_ms = None
    packet_loss_percent = 100

    if not ping_output:
        return rtt_avg_ms, packet_loss_percent
    
    rtt_match_alpine = re.findall(r'round-trip min/avg/max = [\d.]+/([\d.]+)/[\d.]+ ms', ping_output)
    rtt_match_ubuntu = re.findall(r'rtt min/avg/max/mdev = [\d.]+/([\d.]+)/[\d.]+/[\d.]+ ms', ping_output)
    if rtt_match_alpine:
        rtt_avg_ms = float(rtt_match_alpine[0])
    elif rtt_match_ubuntu:
        rtt_avg_ms = float(rtt_match_ubuntu[0])

    loss_match = re.findall(r'(\d+)% packet loss', ping_output)
    if loss_match:
        packet_loss_percent = int(loss_match[0])
    return rtt_avg_ms, packet_loss_percent


"""
iperf3のJSON出力を解析してスループット(bps)等を抽出するための関数.
"""
def parse_iperf3_json_output(iperf_output):
    throughput_bps, jitter_ms, lost_packets, lost_percent = None, None, None, 100
    if not iperf_output:
        return throughput_bps, jitter_ms, lost_packets, lost_percent
    try:
        data = json.loads(iperf_output)
        if 'end' in data:
            sum_data = data['end'].get('sum_received') or data['end'].get('sum') # TCP or UDP
            if sum_data:
                throughput_bps = sum_data.get('bits_per_second')
                jitter_ms = sum_data.get('jitter_ms')
                lost_packets = sum_data.get('lost_packets')
                lost_percent = sum_data.get('lost_percent')

    except json.JSONDecodeError:
        print(f"Error: Failed to parse iperf3 JSON output: {iperf_output[:200]}...")
    except KeyError as e:
        print(f"Error: Key not found in iperf3 JSON output - {e}")
    return throughput_bps, jitter_ms, lost_packets, lost_percent

def write_log_csv(timestamp, source_container, target_container, rtt_avg_ms, packet_loss_percent,
                  tcp_throughput_mbps, udp_throughput_mbps, udp_jitter_ms,
                  udp_lost_packets, udp_lost_percent, is_injected):
    
    output_file_path = os.path.abspath(os.path.join(os.path.dirname(__file__), OUTPUT_CSV_FILE))
    file_exists = os.path.isfile(output_file_path)
    def val_or_empty(val):
        return val if val is not None else ''
    try:
        with open(output_file_path, 'a', newline='', encoding='utf-8') as csvfile:
            fieldnames = ['timestamp', 'source_container', 'target_container',
                          'rtt_avg_ms', 'packet_loss_percent', 'tcp_throughput_mbps',
                          'udp_throughput_mbps', 'udp_jitter_ms', 'udp_lost_packets',
                          'udp_lost_percent', 'is_injected']
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            if not file_exists or os.path.getsize(output_file_path) == 0:
                writer.writeheader()
            writer.writerow({
                'timestamp': timestamp,
                'source_container': source_container,
                'target_container': target_container,
                'rtt_avg_ms': val_or_empty(rtt_avg_ms),
                'packet_loss_percent': val_or_empty(packet_loss_percent),
                'tcp_throughput_mbps': val_or_empty(tcp_throughput_mbps),
                'udp_throughput_mbps': val_or_empty(udp_throughput_mbps),
                'udp_jitter_ms': val_or_empty(udp_jitter_ms),
                'udp_lost_packets': val_or_empty(udp_lost_packets),
                'udp_lost_percent': val_or_empty(udp_lost_percent),
                'is_injected': str(is_injected).lower()
            })
    except IOError as e:
        print(f"Error writing to CSV file {output_file_path}: {e}")
    except Exception as e:
        print(f"An unexpected error occurred during CSV write: {e}")


"""
通信品質を一定間隔で測定するループ関数.
"""
def main_loop_process(stop_event_param):
    global iperf_server_started_flag, fault_injected_flag, fault_flag_lock

    current_client_container = CLIENT_CONTAINER_NAME
    current_server_container = SERVER_CONTAINER_NAME
    current_server_ip = SERVER_IP
    current_ping_count = PING_COUNT
    current_iperf_duration = IPERF_DURATION_SEC
    current_loop_interval = MEASUREMENT_INTERVAL_SEC

    print(f"Starting network quality monitoring thread (main_loop_process)...")
    print(f" Client: {current_client_container}, Server: {current_server_container} ({current_server_ip})")
    print(f" Loop Interval: {current_loop_interval}s, Ping Count: {current_ping_count}, iPerf Duration: {current_iperf_duration}s")
    print(f"Attempting to start iperf3 server on {current_server_container}...")
    iperf_server_cmd = ["iperf3", "-s", "-D"]
    server_start_output = run_clab_command(current_server_container, iperf_server_cmd, task_name="IperfServerStart", timeout_override=10, check_return_code=False)
    if server_start_output is not None:
        if "failed to daemonize" not in str(server_start_output) or "Address already in use" in str(server_start_output):
            print("iperf3 server started or already running.")
            iperf_server_started_flag = True
        else:
            print(f"Failed to start iperf3 server. Output: {str(server_start_output).strip()}")
            iperf_server_started_flag = False
    else:
        print("iperf3 server start command execution failed (e.g., timeout).")
        iperf_server_started_flag = False
    if not iperf_server_started_flag:
        print("Warning: iperf3 server is not running. iperf3 tests will likely fail.")


    while not stop_event_param.is_set():
        current_timestamp = datetime.datetime.now().isoformat(timespec='seconds')
        
        # --- 現在の障害注入フラグの値を取得 ---
        with fault_flag_lock:
            current_fault_flag = fault_injected_flag
        #print(f"\n[{current_timestamp}] Performing measurements (Fault Injected: {current_fault_flag})...")


        rtt_avg, loss = None, None
        tcp_throughput_mbps, udp_throughput_mbps, jitter, lost_pkts, lost_pct = None, None, None, None, None

        ping_timeout = max(5, current_ping_count + 3) 
        ping_cmd = ["ping", "-c", str(PING_COUNT), "-q", "-i", str(1/PING_COUNT), SERVER_IP]
        #print(f"  Executing Ping (timeout: {ping_timeout}s)...")
        ping_result = run_clab_command(current_client_container, ping_cmd, task_name="Ping", timeout_override=ping_timeout)
        rtt_avg, loss = parse_ping_output(ping_result)
        #print(f"  Ping -> RTT Avg: {rtt_avg} ms, Loss: {loss}%")

        if stop_event_param.is_set(): break

        if iperf_server_started_flag:
            iperf_timeout = current_iperf_duration + 10 
            iperf_tcp_cmd = ["iperf3", "-c", current_server_ip, "-t", str(current_iperf_duration), "-J", "-P", "1"]
            #print(f"  Executing iperf TCP (duration: {current_iperf_duration}s, timeout: {iperf_timeout}s)...")
            iperf_tcp_result = run_clab_command(current_client_container, iperf_tcp_cmd, task_name="IperfTCP", timeout_override=iperf_timeout)
            raw_tcp_throughput, _, _, _ = parse_iperf3_json_output(iperf_tcp_result)
            if raw_tcp_throughput is not None:
                tcp_throughput_mbps = round(raw_tcp_throughput / 1_000_000, 2)
                #print(f"  iperf TCP -> Throughput: {tcp_throughput_mbps} Mbps")
            else:
                print("  iperf TCP -> Measurement failed or produced no result.")

            if stop_event_param.is_set(): break

            udp_bandwidth = "10M"
            iperf_udp_cmd = ["iperf3", "-c", current_server_ip, "-t", str(current_iperf_duration), "-u", "-b", udp_bandwidth, "-J", "-P", "1"]
            #print(f"  Executing iperf UDP (duration: {current_iperf_duration}s, target_bw: {udp_bandwidth}, timeout: {iperf_timeout}s)...")
            iperf_udp_result = run_clab_command(current_client_container, iperf_udp_cmd, task_name="IperfUDP", timeout_override=iperf_timeout)
            raw_udp_throughput, raw_jitter, raw_lost_pkts, raw_lost_pct = parse_iperf3_json_output(iperf_udp_result)
            if raw_udp_throughput is not None:
                udp_throughput_mbps = round(raw_udp_throughput / 1_000_000, 2)
                jitter = raw_jitter
                lost_pkts = raw_lost_pkts
                lost_pct = raw_lost_pct
                #print(f"  iperf UDP -> Throughput: {udp_throughput_mbps} Mbps, Jitter: {jitter} ms")
            else:
                print("  iperf UDP -> Measurement failed or produced no result.")
        else:
            print("  iperf tests skipped because iperf3 server is not running.")
        
        write_log_csv(current_timestamp, current_client_container, current_server_container,
                      rtt_avg, loss, tcp_throughput_mbps, udp_throughput_mbps,
                      jitter, lost_pkts, lost_pct, current_fault_flag)

        for _ in range(current_loop_interval):
            if stop_event_param.is_set():
                break
            time.sleep(0.1)
    
    print("Measurement loop stopping as requested...")


"""
以下, FlaskのAPI
"""
def is_loop_running_check():
    global loop_thread
    return loop_thread is not None and loop_thread.is_alive()

@app.route('/api/measure/status', methods=['GET'])
def measure_status():
    return jsonify({'is_running': is_loop_running_check()})

@app.route('/api/measure/start', methods=['POST'])
def start_measures_route():
    global loop_thread, stop_event, iperf_server_started_flag, fault_injected_flag, fault_flag_lock
    global CLIENT_CONTAINER_NAME, SERVER_CONTAINER_NAME, SERVER_IP, \
           MEASUREMENT_INTERVAL_SEC, PING_COUNT, IPERF_DURATION_SEC

    if is_loop_running_check():
        return jsonify({'status': 'info', 'message': 'Measurement is already running.'})
    
    #print("API: Start measurement request received.")
    data = request.get_json()
    if data:
        #print(f"Received config from frontend: {data}")
        CLIENT_CONTAINER_NAME = data.get('clientContainerName', CLIENT_CONTAINER_NAME)
        SERVER_CONTAINER_NAME = data.get('serverContainerName', SERVER_CONTAINER_NAME)
        SERVER_IP = data.get('serverIp', SERVER_IP)
        def get_int_param(key, current_value, min_val=1):
            val_str = data.get(key)
            if val_str is not None:
                try: val_int = int(val_str); return max(min_val, val_int)
                except (ValueError, TypeError): app.logger.warning(f"Invalid value for {key}: '{val_str}'. Using current value: {current_value}"); return current_value
            return current_value
        MEASUREMENT_INTERVAL_SEC = get_int_param('measurementIntervalSec', MEASUREMENT_INTERVAL_SEC, 1)
        PING_COUNT = get_int_param('pingCount', PING_COUNT, 1)
        IPERF_DURATION_SEC = get_int_param('iperfDurationSec', IPERF_DURATION_SEC, 1)
    else:
        print("No config data received from frontend, using default values for measurement loop.")
    
    """
    print(f"Using config: CLIENT='{CLIENT_CONTAINER_NAME}', SERVER='{SERVER_CONTAINER_NAME}', IP='{SERVER_IP}', "
          f"LOOP_INTERVAL={MEASUREMENT_INTERVAL_SEC}, PING_COUNT_CFG={PING_COUNT}, IPERF_DUR_CFG={IPERF_DURATION_SEC}")
    """
            
    stop_event.clear()
    iperf_server_started_flag = False
    # --- 測定開始時に障害フラグをリセット ---
    with fault_flag_lock:
        fault_injected_flag = False
    #print("Fault injected flag reset to False at the start of measurement.")
            
    loop_thread = threading.Thread(target=main_loop_process, args=(stop_event,), daemon=True)
    loop_thread.start()
    time.sleep(0.5) 
    
    if is_loop_running_check():
        return jsonify({'status': 'success', 'message': 'Measurement started.'})
    else:
        loop_thread = None 
        iperf_server_started_flag = False
        return jsonify({'status': 'error', 'message': 'Failed to start measurement loop. Check console for errors.'})


@app.route('/api/measure/stop', methods=['POST'])
def stop_measures_route():
    global loop_thread, stop_event, iperf_server_started_flag, MEASUREMENT_INTERVAL_SEC, IPERF_DURATION_SEC, PING_COUNT
    if not is_loop_running_check():
        return jsonify({'status': 'info', 'message': 'Measurement is not running.'})

    #print("API: Stop measurement request received.")
    stop_event.set()
    if loop_thread:
        estimated_single_cycle_time = PING_COUNT + (IPERF_DURATION_SEC * 2) + 10 # 概算
        wait_timeout = max(10, MEASUREMENT_INTERVAL_SEC + estimated_single_cycle_time)
        loop_thread.join(timeout=wait_timeout) 
    
    final_message = ""
    status_type = "success" 
    if loop_thread and loop_thread.is_alive():
        final_message += 'Failed to stop measurement thread gracefully. '
        status_type = "error"
        print("Warning: Measurement thread did not terminate in time.")
    else:
        final_message += 'Measurement loop stopping command sent. '
        loop_thread = None 
    if iperf_server_started_flag:
        #print(f"Attempting to stop iperf3 server on {SERVER_CONTAINER_NAME}...")
        kill_iperf_cmd = ["pkill", "-SIGTERM", "iperf3"]
        kill_output = run_clab_command(SERVER_CONTAINER_NAME, kill_iperf_cmd, task_name="IperfServerStop",timeout_override=5, check_return_code=False)
        if kill_output is not None and "no process found" not in str(kill_output).lower() and \
           ("terminated" in str(kill_output).lower() or not str(kill_output).strip()):
             final_message += 'iperf3 server stop command processed. '
        elif "no process found" in str(kill_output).lower():
             final_message += 'iperf3 server was not found running. '
        else:
             final_message += f'iperf3 server might require manual stop (Output: {str(kill_output).strip()}). '
             if status_type == "success": status_type = "warning"
        iperf_server_started_flag = False
    if status_type == "success" and not (loop_thread and loop_thread.is_alive()):
        final_message = 'Measurement stopped successfully.'
    return jsonify({'status': status_type, 'message': final_message.strip()})


# --- 障害注入フラグを操作するAPIエンドポイント ---
@app.route('/api/measure/set_fault_flag', methods=['POST'])
def set_fault_flag_api():
    global fault_injected_flag, fault_flag_lock
    data = request.get_json()
    new_flag_state = data.get('is_injected', False) # デフォルトはFalse

    if not isinstance(new_flag_state, bool):
        return jsonify({'status': 'error', 'message': 'Invalid value for is_injected. Must be true or false.'}), 400

    with fault_flag_lock:
        fault_injected_flag = new_flag_state
    
    #print(f"API: Fault injected flag set to {fault_injected_flag}")
    return jsonify({'status': 'success', 'message': f'Fault injected flag set to {fault_injected_flag}.', 'current_flag_state': fault_injected_flag})


"""
CSVの値をJSON用にパースする関数.
"""
def parse_csv_value_for_json(value_str):
    if value_str is None or value_str == '': return None
    try:
        if '.' in value_str: return float(value_str)
        return int(value_str)
    except ValueError: return None

@app.route('/api/measure/csv_data', methods=['GET'])
def get_csv_data_api():
    csv_file_path = os.path.abspath(os.path.join(os.path.dirname(__file__), OUTPUT_CSV_FILE))
    if not os.path.exists(csv_file_path):
        app.logger.error(f"CSV file not found at {csv_file_path}")
        return jsonify({"error": "CSV file not found", "path_checked": csv_file_path}), 404
    data_rows = []
    try:
        with open(csv_file_path, mode='r', encoding='utf-8-sig') as csvfile:
            reader = csv.DictReader(csvfile)
            if not reader.fieldnames:
                 app.logger.warning(f"CSV file {csv_file_path} is empty or has no headers.")
                 return jsonify([])
            # CSVヘッダーの正規化（小文字、スペースをアンダースコアに）
            csv_header_map = {f.lower().strip().replace(" ", "_"): f for f in reader.fieldnames}
            expected_metric_keys = [ # is_injected はCSVから直接読むのでここには含めない
                'rtt_avg_ms', 'packet_loss_percent', 'tcp_throughput_mbps',
                'udp_throughput_mbps', 'udp_jitter_ms', 'udp_lost_packets', 'udp_lost_percent'
            ]
            for row_dict_raw in reader:
                processed_row = {}
                # タイムスタンプ (必須)
                ts_original_key = csv_header_map.get('timestamp')
                if not ts_original_key or not row_dict_raw.get(ts_original_key):
                    continue
                processed_row['timestamp'] = row_dict_raw[ts_original_key]
                
                # source/target container
                for key_pair in [('source_container', 'source_container'), ('target_container', 'target_container')]:
                    expected_k, csv_k_base = key_pair
                    original_k = csv_header_map.get(csv_k_base)
                    if original_k: processed_row[expected_k] = row_dict_raw.get(original_k)

                # メトリクス値
                for key in expected_metric_keys:
                    original_metric_key = csv_header_map.get(key) # CSV内の実際のヘッダー名
                    if original_metric_key:
                        processed_row[key] = parse_csv_value_for_json(row_dict_raw.get(original_metric_key))
                    else:
                        processed_row[key] = None
                
                # --- is_injected フラグをCSVから読み込む ---
                is_injected_original_key = csv_header_map.get('is_injected')
                if is_injected_original_key:
                    # CSVには "true" / "false" の文字列として保存されていると仮定
                    injected_val_str = row_dict_raw.get(is_injected_original_key, 'false').lower()
                    processed_row['is_injected'] = injected_val_str == 'true'
                else:
                    processed_row['is_injected'] = False # CSVにカラムがなければFalse扱い
                data_rows.append(processed_row)
        return jsonify(data_rows)
    except Exception as e:
        app.logger.error(f"Error reading/parsing CSV '{csv_file_path}': {e}", exc_info=True)
        return jsonify({"error": "Failed to process CSV file", "details": str(e)}), 500