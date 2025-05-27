import subprocess
import re
import datetime
import csv
import time
import os
import json
import threading

from ceapp import app
from flask import request, jsonify # jsonify をインポート

# app.secret_key の行は __init__.py で設定するため削除

# --- 設定項目 (変更なし) ---
CLIENT_CONTAINER_NAME = "clab-ospf-pc1"
SERVER_CONTAINER_NAME = "clab-ospf-pc2"
SERVER_IP = "192.168.12.10"
MEASUREMENT_INTERVAL_SEC = 1
PING_COUNT = 1
IPERF_DURATION_SEC = 1
OUTPUT_CSV_FILE = "../result.csv" # backendディレクトリからの相対パスになる
# --- 設定項目終わり ---

# --- グローバル変数 (変更なし) ---
loop_thread = None
stop_event = threading.Event()
iperf_server_started_flag = False

# --- 既存の関数群 (run_clab_command, parse_ping_output, parse_iperf3_json_output, write_log, main_loop_process) は変更なし ---
# (main_loop_process内のprint文はサーバーコンソールに出力されます)
def run_clab_command(container_name, command_list, timeout_override=None, check_return_code=True):
    """指定されたコンテナ内でコマンドを実行し、標準出力を返す"""
    cmd = ["docker", "exec", container_name] + command_list
    try:
        # MEASUREMENT_INTERVAL_SECが小さい場合でも、コマンド実行にはある程度の時間を見込む
        timeout_val = timeout_override if timeout_override is not None else max(5, MEASUREMENT_INTERVAL_SEC + 2)
        result = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=timeout_val)

        if check_return_code and result.returncode != 0:
            print(f"Error: Command {' '.join(command_list)} in {container_name} failed with code {result.returncode}")
            print(f"Stderr: {result.stderr.strip()}")
            # iperf3サーバー起動時の "Address already in use" はエラーではない場合もある
            if "iperf3 -s" in " ".join(command_list) and "Address already in use" in result.stderr:
                print("Note: iperf3 server might be already running or port is in use.")
                return result.stderr # エラーメッセージを返し、呼び出し元で判断
            return None
        return result.stdout if result.returncode == 0 else result.stderr # 成功ならstdout、失敗(check_return_code=False時)ならstderr
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

    # RTT avg
    rtt_match_alpine = re.findall(r'round-trip min/avg/max = [\d.]+/([\d.]+)/[\d.]+ ms', ping_output)
    rtt_match_ubuntu = re.findall(r'rtt min/avg/max/mdev = [\d.]+/([\d.]+)/[\d.]+/[\d.]+ ms', ping_output)
    if rtt_match_alpine:
        rtt_avg_ms = float(rtt_match_alpine[0])
    elif rtt_match_ubuntu:
        rtt_avg_ms = float(rtt_match_ubuntu[0])

    # Packet Loss 
    loss_match = re.findall(r'(\d+)% packet loss', ping_output)
    if loss_match:
        packet_loss_percent = int(loss_match[0])

    return rtt_avg_ms, packet_loss_percent

def parse_iperf3_json_output(iperf_output):
    """iperf3のJSON出力を解析してスループット(bps)を抽出"""
    throughput_bps = None
    jitter_ms = None
    lost_packets = None
    lost_percent = None

    if not iperf_output:
        return throughput_bps, jitter_ms, lost_packets, lost_percent

    try:
        data = json.loads(iperf_output)
        # TCPの場合(json) 'end' -> 'sum_received' -> 'bits_per_second'
        # UDPの場合(json) 'end' -> 'sum' -> 'bits_per_second', 'jitter_ms', 'lost_packets', 'lost_percent'
        if 'end' in data:
            if data['start']['test_start'].get('protocol') == 'TCP': # TCP Receiver Summary
                throughput_bps = data['end']['sum_received'].get('bits_per_second')
            elif data['start']['test_start'].get('protocol') == 'UDP': # UDP Summary
                throughput_bps = data['end']['sum'].get('bits_per_second')
                jitter_ms = data['end']['sum'].get('jitter_ms')
                lost_packets = data['end']['sum'].get('lost_packets')
                lost_percent = data['end']['sum'].get('lost_percent')

    except json.JSONDecodeError:
        print("Error: Failed to parse iperf3 JSON output.")
    except KeyError as e:
        print(f"Error: Key not found in iperf3 JSON output - {e}")

    return throughput_bps, jitter_ms, lost_packets, lost_percent

def write_log(timestamp, source, target, metric, value):
    if value is None:
        return
    # backend/result.csv になるようにパスを調整
    output_file_path = os.path.join(os.path.dirname(__file__), '..', OUTPUT_CSV_FILE)
    file_exists = os.path.isfile(output_file_path)
    try:
        with open(output_file_path, 'a', newline='') as csvfile:
            fieldnames = ['timestamp', 'source_container', 'target_ip', 'metric', 'value']
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            if not file_exists or os.path.getsize(output_file_path) == 0:
                writer.writeheader()
            writer.writerow({
                'timestamp': timestamp,
                'source_container': source,
                'target_ip': target,
                'metric': metric,
                'value': value
            })
    except IOError as e:
        print(f"Error writing to CSV file {output_file_path}: {e}")
    except Exception as e:
        print(f"An unexpected error occurred during CSV write: {e}")

def main_loop_process(stop_event_param):
    """測定を定期的に実行するメインループ (スレッド内で実行される関数)"""
    global iperf_server_started_flag
    print(f"Starting network quality monitoring thread...")
    print(f" Client: {CLIENT_CONTAINER_NAME}, Server: {SERVER_CONTAINER_NAME} ({SERVER_IP})")
    print(f" Interval: {MEASUREMENT_INTERVAL_SEC}s, Output: {OUTPUT_CSV_FILE}")

    # iperf3サーバーを起動 (-D でデーモン化)
    print(f"Attempting to start iperf3 server on {SERVER_CONTAINER_NAME}...")
    iperf_server_cmd = ["iperf3", "-s", "-D"]
    server_start_output = run_clab_command(SERVER_CONTAINER_NAME, iperf_server_cmd, timeout_override=10, check_return_code=False)

    if server_start_output is not None:
        if "failed to daemonize" not in server_start_output or "Address already in use" in server_start_output:
            print("iperf3 server started or already running.")
            iperf_server_started_flag = True
        else:
            print(f"Failed to start iperf3 server. Stderr: {server_start_output.strip()}")
            iperf_server_started_flag = False
    else:
        print("iperf3 server start command execution failed (e.g., timeout).")
        iperf_server_started_flag = False

    if not iperf_server_started_flag:
        print("Warning: iperf3 server is not running. iperf3 tests will likely fail.")

    while not stop_event_param.is_set():
        current_timestamp = datetime.datetime.now().isoformat(timespec='seconds')
        print(f"\n[{current_timestamp}] Performing measurements...")

        ping_cmd = ["ping", "-c", str(PING_COUNT), "-W", "1", SERVER_IP]
        ping_result = run_clab_command(CLIENT_CONTAINER_NAME, ping_cmd)
        rtt_avg, loss = parse_ping_output(ping_result)
        print(f"  Ping -> RTT Avg: {rtt_avg} ms, Loss: {loss}%")
        write_log(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_IP, "rtt_avg_ms", rtt_avg)
        write_log(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_IP, "packet_loss_percent", loss)

        if iperf_server_started_flag:
            iperf_tcp_cmd = ["iperf3", "-c", SERVER_IP, "-t", str(IPERF_DURATION_SEC), "-J"]
            iperf_tcp_result = run_clab_command(CLIENT_CONTAINER_NAME, iperf_tcp_cmd)
            tcp_throughput, _, _, _ = parse_iperf3_json_output(iperf_tcp_result)
            if tcp_throughput is not None:
                tcp_throughput_mbps = tcp_throughput / 1_000_000
                print(f"  iperf3 TCP -> Throughput: {tcp_throughput_mbps:.2f} Mbps")
                write_log(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_IP, "tcp_throughput_mbps", round(tcp_throughput_mbps, 2))
            else:
                print("  iperf3 TCP -> Measurement failed or produced no result.")

            udp_bandwidth = "10M"
            iperf_udp_cmd = ["iperf3", "-c", SERVER_IP, "-t", str(IPERF_DURATION_SEC), "-u", "-b", udp_bandwidth, "-J"]
            iperf_udp_result = run_clab_command(CLIENT_CONTAINER_NAME, iperf_udp_cmd)
            udp_throughput, jitter, lost_pkts, lost_pct = parse_iperf3_json_output(iperf_udp_result)
            if udp_throughput is not None:
                udp_throughput_mbps = udp_throughput / 1_000_000
                print(f"  iperf3 UDP -> Throughput: {udp_throughput_mbps:.2f} Mbps (Target: {udp_bandwidth})")
                print(f"  iperf3 UDP -> Jitter: {jitter} ms, Lost: {lost_pkts} ({lost_pct}%)")
                write_log(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_IP, "udp_throughput_mbps", round(udp_throughput_mbps, 2))
                write_log(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_IP, "udp_jitter_ms", jitter)
                write_log(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_IP, "udp_lost_packets", lost_pkts)
                write_log(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_IP, "udp_lost_percent", lost_pct)
            else:
                print("  iperf3 UDP -> Measurement failed or produced no result.")
        else:
            print("  iperf3 tests skipped because iperf3 server is not running.")

        for _ in range(MEASUREMENT_INTERVAL_SEC):
            if stop_event_param.is_set():
                break
            time.sleep(1)
    
    print("Measurement loop stopping as requested...")


def is_loop_running_check():
    global loop_thread
    return loop_thread is not None and loop_thread.is_alive()

# --- API Routes ---
@app.route('/api/measure/status', methods=['GET'])
def measure_status():
    return jsonify({'is_running': is_loop_running_check()})

@app.route('/api/measure/start', methods=['POST'])
def start_measures_route():
    global loop_thread, stop_event, iperf_server_started_flag
    if is_loop_running_check():
        return jsonify({'status': 'info', 'message': 'Measurement is already running.'})
    
    print("API: Start measurement request received.")
    stop_event.clear()
    iperf_server_started_flag = False
    loop_thread = threading.Thread(target=main_loop_process, args=(stop_event,), daemon=True)
    loop_thread.start()
    time.sleep(0.5) # Allow thread to start
    
    if is_loop_running_check():
        return jsonify({'status': 'success', 'message': 'Measurement started.'})
    else:
        loop_thread = None
        iperf_server_started_flag = False
        return jsonify({'status': 'error', 'message': 'Failed to start measurement loop. Check console for errors.'})

@app.route('/api/measure/stop', methods=['POST'])
def stop_measures_route():
    global loop_thread, stop_event, iperf_server_started_flag
    if not is_loop_running_check():
        return jsonify({'status': 'info', 'message': 'Measurement is not running.'})

    print("API: Stop measurement request received.")
    stop_event.set()
    if loop_thread:
        loop_thread.join(timeout=10)
    
    final_message = ""
    status_type = "success"

    if loop_thread and loop_thread.is_alive():
        final_message += 'Failed to stop measurement thread gracefully. '
        status_type = "error"
        print("Warning: Measurement thread did not terminate in time.")
    else:
        final_message += 'Measurement loop stopping... '
        loop_thread = None

    if iperf_server_started_flag:
        print(f"Attempting to stop iperf3 server on {SERVER_CONTAINER_NAME}...")
        kill_iperf_cmd = ["pkill", "-SIGTERM", "iperf3"]
        kill_output = run_clab_command(SERVER_CONTAINER_NAME, kill_iperf_cmd, timeout_override=5, check_return_code=False)
        if kill_output is not None and "iperf3: no process found" not in kill_output.lower() and "terminated" in kill_output.lower():
             final_message += 'iperf3 server stop command sent and likely terminated.'
        elif kill_output is not None and "iperf3: no process found" in kill_output.lower():
             final_message += 'iperf3 server was not found running or already stopped.'
        else:
             final_message += 'iperf3 server may require manual stop. Check console.'
             if status_type == "success": status_type = "warning" # Downgrade if not error already
        iperf_server_started_flag = False
    else:
        if not (loop_thread and loop_thread.is_alive()):
            final_message += 'Measurement stopped successfully.'
            
    return jsonify({'status': status_type, 'message': final_message.strip()})