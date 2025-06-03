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

# --- 設定項目 ---
CLIENT_CONTAINER_NAME = "clab-ospf-pc1"
SERVER_CONTAINER_NAME = "clab-ospf-pc2"
SERVER_IP = "192.168.12.10"
MEASUREMENT_INTERVAL_SEC = 1
PING_COUNT = 1
IPERF_DURATION_SEC = 1
OUTPUT_CSV_FILE = "../../result.csv"
# --- 設定項目終わり ---

# --- グローバル変数 ---
loop_thread = None
stop_event = threading.Event()
iperf_server_started_flag = False

def run_clab_command(container_name, command_list, timeout_override=None, check_return_code=True):
    """指定されたコンテナ内でコマンドを実行し、標準出力を返す"""
    global MEASUREMENT_INTERVAL_SEC
    cmd = ["docker", "exec", container_name] + command_list
    try:
        # MEASUREMENT_INTERVAL_SEC が動的に変わる可能性があるため、ここで参照する
        timeout_val = timeout_override if timeout_override is not None else max(5, MEASUREMENT_INTERVAL_SEC)
        result = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=timeout_val)

        if check_return_code and result.returncode != 0:
            print(f"Error: Command {' '.join(command_list)} in {container_name} failed with code {result.returncode}")
            print(f"Stderr: {result.stderr.strip()}")
            if "iperf3 -s" in " ".join(command_list) and "Address already in use" in result.stderr:
                print("Note: iperf3 server might be already running or port is in use.")
                return result.stderr
            return None
        return result.stdout if result.returncode == 0 else result.stderr
    except subprocess.TimeoutExpired:
        print(f"Timeout running command {' '.join(command_list)} in {container_name}")
        return None
    except FileNotFoundError:
        print("Error: 'docker' command not found. Is Docker installed and in PATH?")
        return None
    except Exception as e:
        print(f"An unexpected error occurred running command in {container_name}: {e}")
        return None

def parse_ping_output(ping_output):
    """pingの標準出力を解析してRTT avgとロス率を抽出"""
    rtt_avg_ms = None
    packet_loss_percent = None
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

def parse_iperf3_json_output(iperf_output):
    """iperf3のJSON出力を解析してスループット(bps)等を抽出"""
    throughput_bps, jitter_ms, lost_packets, lost_percent = None, None, None, None
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
                  udp_lost_packets, udp_lost_percent):
    output_file_path = os.path.abspath(os.path.join(os.path.dirname(__file__), OUTPUT_CSV_FILE))
    file_exists = os.path.isfile(output_file_path)
    
    def val_or_empty(val):
        return val if val is not None else ''

    try:
        with open(output_file_path, 'a', newline='', encoding='utf-8') as csvfile:
            fieldnames = ['timestamp', 'source_container', 'target_container',
                          'rtt_avg_ms', 'packet_loss_percent', 'tcp_throughput_mbps',
                          'udp_throughput_mbps', 'udp_jitter_ms', 'udp_lost_packets',
                          'udp_lost_percent']
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
                'udp_lost_percent': val_or_empty(udp_lost_percent)
            })
    except IOError as e:
        print(f"Error writing to CSV file {output_file_path}: {e}")
    except Exception as e:
        print(f"An unexpected error occurred during CSV write: {e}")

def main_loop_process(stop_event_param):
    global iperf_server_started_flag
    global CLIENT_CONTAINER_NAME, SERVER_CONTAINER_NAME, SERVER_IP, \
           MEASUREMENT_INTERVAL_SEC, PING_COUNT, IPERF_DURATION_SEC, OUTPUT_CSV_FILE

    print(f"Starting network quality monitoring thread...")
    print(f" Client: {CLIENT_CONTAINER_NAME}, Server: {SERVER_CONTAINER_NAME} ({SERVER_IP})")
    print(f" Interval: {MEASUREMENT_INTERVAL_SEC}s, Ping Count: {PING_COUNT}, iPerf Duration: {IPERF_DURATION_SEC}s")
    print(f" Output: {OUTPUT_CSV_FILE}")


    print(f"Attempting to start iperf3 server on {SERVER_CONTAINER_NAME}...")
    iperf_server_cmd = ["iperf3", "-s", "-D"]
    server_start_output = run_clab_command(SERVER_CONTAINER_NAME, iperf_server_cmd, timeout_override=10, check_return_code=False)

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
        print(f"\n[{current_timestamp}] Performing measurements...")

        rtt_avg, loss = None, None
        raw_tcp_throughput, raw_udp_throughput, raw_jitter, raw_lost_pkts, raw_lost_pct = None, None, None, None, None
        tcp_throughput_mbps, udp_throughput_mbps, jitter, lost_pkts, lost_pct = None, None, None, None, None

        ping_cmd = ["ping", "-c", str(PING_COUNT), "-W", "1", SERVER_IP]
        ping_result = run_clab_command(CLIENT_CONTAINER_NAME, ping_cmd, timeout_override=max(3, PING_COUNT + 1)) # Ping timeout調整
        rtt_avg, loss = parse_ping_output(ping_result)
        print(f"  Ping -> RTT Avg: {rtt_avg} ms, Loss: {loss}%")

        if iperf_server_started_flag:
            iperf_tcp_cmd = ["iperf3", "-c", SERVER_IP, "-t", str(IPERF_DURATION_SEC), "-J"]
            iperf_tcp_result = run_clab_command(CLIENT_CONTAINER_NAME, iperf_tcp_cmd, timeout_override=IPERF_DURATION_SEC + 5)
            raw_tcp_throughput, _, _, _ = parse_iperf3_json_output(iperf_tcp_result)
            if raw_tcp_throughput is not None:
                tcp_throughput_mbps = round(raw_tcp_throughput / 1_000_000, 2)
                print(f"  iperf3 TCP -> Throughput: {tcp_throughput_mbps} Mbps")
            else:
                print("  iperf3 TCP -> Measurement failed or produced no result.")

            udp_bandwidth = "10M" 
            iperf_udp_cmd = ["iperf3", "-c", SERVER_IP, "-t", str(IPERF_DURATION_SEC), "-u", "-b", udp_bandwidth, "-J"]
            iperf_udp_result = run_clab_command(CLIENT_CONTAINER_NAME, iperf_udp_cmd, timeout_override=IPERF_DURATION_SEC + 5)
            raw_udp_throughput, raw_jitter, raw_lost_pkts, raw_lost_pct = parse_iperf3_json_output(iperf_udp_result)
            if raw_udp_throughput is not None:
                udp_throughput_mbps = round(raw_udp_throughput / 1_000_000, 2)
                jitter = raw_jitter 
                lost_pkts = raw_lost_pkts
                lost_pct = raw_lost_pct
                print(f"  iperf3 UDP -> Throughput: {udp_throughput_mbps} Mbps (Target: {udp_bandwidth})")
                print(f"  iperf3 UDP -> Jitter: {jitter} ms, Lost: {lost_pkts} pkts ({lost_pct}%)")
            else:
                print("  iperf3 UDP -> Measurement failed or produced no result.")
        else:
            print("  iperf3 tests skipped because iperf3 server is not running.")
        
        write_log_csv(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_CONTAINER_NAME,
                      rtt_avg, loss, tcp_throughput_mbps, udp_throughput_mbps,
                      jitter, lost_pkts, lost_pct)

        for _ in range(MEASUREMENT_INTERVAL_SEC):
            if stop_event_param.is_set():
                break
            time.sleep(1)
    
    print("Measurement loop stopping as requested...")

def is_loop_running_check():
    global loop_thread
    return loop_thread is not None and loop_thread.is_alive()

@app.route('/api/measure/status', methods=['GET'])
def measure_status():
    return jsonify({'is_running': is_loop_running_check()})

@app.route('/api/measure/start', methods=['POST'])
def start_measures_route():
    global loop_thread, stop_event, iperf_server_started_flag
    global CLIENT_CONTAINER_NAME, SERVER_CONTAINER_NAME, SERVER_IP, \
           MEASUREMENT_INTERVAL_SEC, PING_COUNT, IPERF_DURATION_SEC

    if is_loop_running_check():
        return jsonify({'status': 'info', 'message': 'Measurement is already running.'})
    
    print("API: Start measurement request received.")

    # フロントエンドから設定値を取得
    data = request.get_json()
    if data:
        print(f"Received config from frontend: {data}")
        # .get(key, default_value) を使用して、キーが存在しない場合は現在のグローバル変数の値（デフォルト値）を使用
        CLIENT_CONTAINER_NAME = data.get('clientContainerName', CLIENT_CONTAINER_NAME)
        SERVER_CONTAINER_NAME = data.get('serverContainerName', SERVER_CONTAINER_NAME)
        SERVER_IP = data.get('serverIp', SERVER_IP)
        
        try:
            # 数値型はintに変換。無効な値の場合はデフォルト値を使用する
            val = data.get('measurementIntervalSec')
            MEASUREMENT_INTERVAL_SEC = int(val) if val is not None and str(val).isdigit() and int(val) >=1 else MEASUREMENT_INTERVAL_SEC
            if int(val) < 1 and val is not None : MEASUREMENT_INTERVAL_SEC = 1 # 最小値保証
        except (ValueError, TypeError):
            app.logger.warning(f"Invalid measurementIntervalSec value '{data.get('measurementIntervalSec')}', using default: {MEASUREMENT_INTERVAL_SEC}")
        
        try:
            val = data.get('pingCount')
            PING_COUNT = int(val) if val is not None and str(val).isdigit() and int(val) >=1 else PING_COUNT
            if int(val) < 1 and val is not None : PING_COUNT = 1 # 最小値保証
        except (ValueError, TypeError):
            app.logger.warning(f"Invalid pingCount value '{data.get('pingCount')}', using default: {PING_COUNT}")

        try:
            val = data.get('iperfDurationSec')
            IPERF_DURATION_SEC = int(val) if val is not None and str(val).isdigit() and int(val) >=1 else IPERF_DURATION_SEC
            if int(val) < 1 and val is not None : IPERF_DURATION_SEC = 1 # 最小値保証
        except (ValueError, TypeError):
            app.logger.warning(f"Invalid iperfDurationSec value '{data.get('iperfDurationSec')}', using default: {IPERF_DURATION_SEC}")
    else:
        print("No config data received from frontend, using default values.")

    print(f"Using config: CLIENT='{CLIENT_CONTAINER_NAME}', SERVER='{SERVER_CONTAINER_NAME}', IP='{SERVER_IP}', "
          f"INTERVAL={MEASUREMENT_INTERVAL_SEC}, PING_COUNT={PING_COUNT}, IPERF_DUR={IPERF_DURATION_SEC}")
            
    stop_event.clear()
    iperf_server_started_flag = False
            
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
    global loop_thread, stop_event, iperf_server_started_flag, MEASUREMENT_INTERVAL_SEC # MEASUREMENT_INTERVAL_SEC を join timeout で使用
    if not is_loop_running_check():
        return jsonify({'status': 'info', 'message': 'Measurement is not running.'})

    print("API: Stop measurement request received.")
    stop_event.set()
    if loop_thread:
        # MEASUREMENT_INTERVAL_SEC が動的に変わる可能性があるため、ここで参照する
        loop_thread.join(timeout=max(10, MEASUREMENT_INTERVAL_SEC * 2 + 5)) 
    
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
        print(f"Attempting to stop iperf3 server on {SERVER_CONTAINER_NAME}...")
        kill_iperf_cmd = ["pkill", "-SIGTERM", "iperf3"]
        kill_output = run_clab_command(SERVER_CONTAINER_NAME, kill_iperf_cmd, timeout_override=5, check_return_code=False)
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

def parse_csv_value_for_json(value_str):
    if value_str is None or value_str == '':
        return None
    try:
        if '.' in value_str:
            return float(value_str)
        return int(value_str)
    except ValueError:
        return None

@app.route('/api/measure/csv_data', methods=['GET'])
def get_csv_data_api():
    csv_file_path = os.path.join(os.path.dirname(__file__), OUTPUT_CSV_FILE)
    if not os.path.exists(csv_file_path):
        app.logger.error(f"CSV file not found at {csv_file_path}")
        return jsonify({"error": "CSV file not found", "path_checked": csv_file_path}), 404

    data_rows = []
    try:
        with open(csv_file_path, mode='r', encoding='utf-8-sig') as csvfile: # utf-8-sig でBOM付きCSVに対応
            reader = csv.DictReader(csvfile)
            if not reader.fieldnames:
                 app.logger.warning(f"CSV file {csv_file_path} is empty or has no headers.")
                 return jsonify([])

            csv_header_map = {f.lower().strip().replace(" ", "_"): f for f in reader.fieldnames}

            expected_metric_keys = [
                'rtt_avg_ms', 'packet_loss_percent', 'tcp_throughput_mbps',
                'udp_throughput_mbps', 'udp_jitter_ms', 'udp_lost_packets', 'udp_lost_percent'
            ]

            for row_dict_raw in reader:
                # CSVのキーの空白や大文字小文字の違いを吸収
                row_dict = {k.lower().strip().replace(" ", "_"): v for k,v in row_dict_raw.items()}
                processed_row = {}
                
                ts_key_to_check = 'timestamp' # 期待するキー
                ts_original_key = None
                for csv_h_key, original_h_key in csv_header_map.items(): # マッピングから実際のキーを探す
                    if csv_h_key == ts_key_to_check:
                        ts_original_key = original_h_key
                        break
                
                if not ts_original_key or row_dict_raw.get(ts_original_key) is None or row_dict_raw.get(ts_original_key) == '':
                    app.logger.debug(f"Skipping row due to missing or empty timestamp: {row_dict_raw}")
                    continue 
                processed_row['timestamp'] = row_dict_raw[ts_original_key]
                
                for key_pair in [('source_container', 'source_container'), ('target_container', 'target_container')]:
                    expected_k, csv_k_base = key_pair
                    original_k = csv_header_map.get(csv_k_base)
                    if original_k:
                         processed_row[expected_k] = row_dict_raw.get(original_k)

                for key in expected_metric_keys:
                    original_metric_key = csv_header_map.get(key)
                    if original_metric_key:
                        processed_row[key] = parse_csv_value_for_json(row_dict_raw.get(original_metric_key))
                    else:
                        processed_row[key] = None # CSVにカラムがなければNone
                
                data_rows.append(processed_row)
        
        return jsonify(data_rows)
    except Exception as e:
        app.logger.error(f"Error reading or parsing CSV file '{csv_file_path}': {e}", exc_info=True)
        return jsonify({"error": "Failed to process CSV file", "details": str(e)}), 500