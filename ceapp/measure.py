import subprocess
import re
import datetime
import csv
import time
import os
import json
import threading # スレッドとイベントのために追加

from ceapp import app
from flask import Flask, render_template, request, redirect, url_for, flash

app.secret_key = 'your_very_secret_key_here_for_measure_py' # flashメッセージのために必要

# --- 設定項目 ---
CLIENT_CONTAINER_NAME = "r1"
SERVER_CONTAINER_NAME = "r4"
SERVER_IP = "192.168.8.2"
MEASUREMENT_INTERVAL_SEC = 1
PING_COUNT = 1
IPERF_DURATION_SEC = 1
OUTPUT_CSV_FILE = "result.csv"
# --- 設定項目終わり ---

# --- グローバル変数 (ループ制御用) ---
loop_thread = None
stop_event = threading.Event() # ループ停止のためのイベントオブジェクト
iperf_server_started_flag = False # iperf3サーバーが起動中かどうかのフラグ (measure.py内で管理)

# --- 既存の関数群の修正と追加 ---
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
    rtt_match = re.findall(r'round-trip min/avg/max = [\d.]+/([\d.]+)/[\d.]+ ms', ping_output)
    if rtt_match:
        rtt_avg_ms = float(rtt_match[0])

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
    file_exists = os.path.isfile(OUTPUT_CSV_FILE)
    try:
        with open(OUTPUT_CSV_FILE, 'a', newline='') as csvfile:
            fieldnames = ['timestamp', 'source_container', 'target_ip', 'metric', 'value']
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            if not file_exists or os.path.getsize(OUTPUT_CSV_FILE) == 0:
                writer.writeheader()
            writer.writerow({
                'timestamp': timestamp,
                'source_container': source,
                'target_ip': target,
                'metric': metric,
                'value': value
            })
    except IOError as e:
        print(f"Error writing to CSV file {OUTPUT_CSV_FILE}: {e}")
    except Exception as e:
        print(f"An unexpected error occurred during CSV write: {e}")

# --- main_loop の変更 (スレッド内で実行される関数) ---
def main_loop_process(stop_event_param):
    """測定を定期的に実行するメインループ (スレッド内で実行される関数)"""
    global iperf_server_started_flag
    print(f"Starting network quality monitoring thread...")
    print(f" Client: {CLIENT_CONTAINER_NAME}, Server: {SERVER_CONTAINER_NAME} ({SERVER_IP})")
    print(f" Interval: {MEASUREMENT_INTERVAL_SEC}s, Output: {OUTPUT_CSV_FILE}")

    # iperf3サーバーを起動 (-D でデーモン化)
    print(f"Attempting to start iperf3 server on {SERVER_CONTAINER_NAME}...")
    iperf_server_cmd = ["iperf3", "-s", "-D"]
    # サーバー起動は失敗しても測定自体は継続するかもしれないので、check_return_code=False
    server_start_output = run_clab_command(SERVER_CONTAINER_NAME, iperf_server_cmd, timeout_override=10, check_return_code=False)

    if server_start_output is not None:
        # 成功時(デーモン化)は標準出力は通常空。エラーは標準エラーに出る。
        # "Address already in use" は許容する
        if "failed to daemonize" not in server_start_output or "Address already in use" in server_start_output:
            print("iperf3 server started or already running.")
            iperf_server_started_flag = True
        else:
            print(f"Failed to start iperf3 server. Stderr: {server_start_output.strip()}")
            iperf_server_started_flag = False # 起動失敗
    else:
        print("iperf3 server start command execution failed (e.g., timeout).")
        iperf_server_started_flag = False

    if not iperf_server_started_flag:
        print("Warning: iperf3 server is not running. iperf3 tests will likely fail.")
        # ループは継続するが、iperf3テストは失敗する可能性が高いことを通知

    while not stop_event_param.is_set():
        current_timestamp = datetime.datetime.now().isoformat(timespec='seconds')
        print(f"\n[{current_timestamp}] Performing measurements...")

        # --- Ping 測定 ---
        ping_cmd = ["ping", "-c", str(PING_COUNT), "-W", "1", SERVER_IP]
        ping_result = run_clab_command(CLIENT_CONTAINER_NAME, ping_cmd)
        rtt_avg, loss = parse_ping_output(ping_result)
        print(f"  Ping -> RTT Avg: {rtt_avg} ms, Loss: {loss}%")
        write_log(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_IP, "rtt_avg_ms", rtt_avg)
        write_log(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_IP, "packet_loss_percent", loss)

        if iperf_server_started_flag: # iperfサーバーが起動している場合のみテスト実行
            # --- iperf3 測定 (TCP スループット) ---
            iperf_tcp_cmd = ["iperf3", "-c", SERVER_IP, "-t", str(IPERF_DURATION_SEC), "-J"]
            iperf_tcp_result = run_clab_command(CLIENT_CONTAINER_NAME, iperf_tcp_cmd)
            tcp_throughput, _, _, _ = parse_iperf3_json_output(iperf_tcp_result)
            if tcp_throughput is not None:
                tcp_throughput_mbps = tcp_throughput / 1_000_000
                print(f"  iperf3 TCP -> Throughput: {tcp_throughput_mbps:.2f} Mbps")
                write_log(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_IP, "tcp_throughput_mbps", round(tcp_throughput_mbps, 2))
            else:
                print("  iperf3 TCP -> Measurement failed or produced no result.")

            # --- iperf3 測定 (UDP スループット、ジッター、ロス) ---
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

        # 次の測定まで待機 (stop_eventを短い間隔でチェックできるようにする)
        for _ in range(MEASUREMENT_INTERVAL_SEC):
            if stop_event_param.is_set():
                break
            time.sleep(1) # 1秒ごとに停止イベントをチェック
    
    print("Measurement loop stopping as requested by GUI...")
    # iperf3サーバーの停止は /stop_measures ルートで行う

def is_loop_running_check():
    """ループが実行中かどうかを返す"""
    global loop_thread
    return loop_thread is not None and loop_thread.is_alive()

# --- Flask ルート ---
@app.route('/', methods=['GET'])
def index():
    return render_template('index.html', loop_is_running=is_loop_running_check())

@app.route('/start_measures', methods=['POST'])
def start_measures_route():
    global loop_thread, stop_event, iperf_server_started_flag
    if is_loop_running_check():
        flash('Measurement is already running.', 'info')
    else:
        print("GUI: Start measurement request received.")
        stop_event.clear()  # 停止イベントをクリア
        iperf_server_started_flag = False # iperfサーバー起動フラグをリセット
        loop_thread = threading.Thread(target=main_loop_process, args=(stop_event,), daemon=True)
        loop_thread.start()
        # スレッドが実際に開始されるまで少し待つ (より堅牢な方法も検討可)
        time.sleep(0.5)
        if is_loop_running_check():
            flash('Measurement started.', 'success')
        else: # スレッドがすぐに終了した場合 (例えばiperfサーバー起動に致命的な問題があった場合など)
            flash('Failed to start measurement loop. Check console for errors.', 'error')
            # 念のためスレッドオブジェクトをNoneに戻す
            loop_thread = None
            iperf_server_started_flag = False # 確実にリセット
    return redirect(url_for('index'))

@app.route('/stop_measures', methods=['POST'])
def stop_measures_route():
    global loop_thread, stop_event, iperf_server_started_flag
    if not is_loop_running_check():
        flash('Measurement is not running.', 'info')
    else:
        print("GUI: Stop measurement request received.")
        stop_event.set() # ループに停止を通知
        if loop_thread:
            loop_thread.join(timeout=10) # スレッドの終了を最大10秒待つ
        
        if loop_thread and loop_thread.is_alive():
            flash('Failed to stop measurement thread gracefully. It might still be running.', 'error')
            print("Warning: Measurement thread did not terminate in time.")
        else:
            flash('Measurement loop stopping...', 'success') # joinが成功したら
            loop_thread = None # スレッドオブジェクトをクリア

        # iperf3サーバーを停止 (サーバーコンテナ内で pkill を使用)
        if iperf_server_started_flag: # 自分で起動した(と記録されている)場合のみ停止試行
            print(f"Attempting to stop iperf3 server on {SERVER_CONTAINER_NAME}...")
            kill_iperf_cmd = ["pkill", "-SIGTERM", "iperf3"] # SIGTERMで穏やかに終了試行
            # サーバー停止コマンドの成否はここではあまり重要視しない (失敗してもユーザーには通知)
            kill_output = run_clab_command(SERVER_CONTAINER_NAME, kill_iperf_cmd, timeout_override=5, check_return_code=False)
            if kill_output is not None and "iperf3: no process found" not in kill_output.lower() and "terminated" in kill_output.lower():
                 print("iperf3 server stop command sent and likely terminated.")
                 flash('Measurement stopped. iperf3 server stop command sent.', 'success')
            elif kill_output is not None and "iperf3: no process found" in kill_output.lower():
                 print("iperf3 server was not found running or already stopped.")
                 flash('Measurement stopped. iperf3 server was not found running.', 'success')
            else:
                 print(f"iperf3 server stop command result: {kill_output.strip() if kill_output else 'No output/Timeout'}. Manual check may be needed.")
                 flash('Measurement stopped. iperf3 server may require manual stop.', 'warning')
            iperf_server_started_flag = False # 停止試行後はフラグをリセット
        else: # iperfサーバーが起動していなかったか、既に停止処理済みの場合
            if not (loop_thread and loop_thread.is_alive()): # ループも正常終了した場合
                flash('Measurement stopped successfully.', 'success')
    return redirect(url_for('index'))