"""
Measure RTT, Loss, Jitter, and Save file
"""

import subprocess
import re
import datetime
import csv
import time
import os
import json # iperf3のJSON出力を利用するため

from ceapp import app
from flask import Flask, render_template, request, redirect, url_for, flash

# --- 設定項目 ---
# Containerlabで起動したコンテナ名に合わせて変更
CLIENT_CONTAINER_NAME = "r1"  # 例: clab-topo-client
print(CLIENT_CONTAINER_NAME)#testS
SERVER_CONTAINER_NAME = "r4"  # 例: clab-topo-server

# サーバーコンテナのIPアドレス (Containerlabの定義から取得するのが望ましいが、ここでは固定値とする)
SERVER_IP = "2001:db8:7::2" # 例: サーバーコンテナに割り当てられたIP

MEASUREMENT_INTERVAL_SEC = 1  # 測定間隔（秒）
PING_COUNT = 1                # pingの試行回数
IPERF_DURATION_SEC = 10       # iperf3の測定時間（秒）
OUTPUT_CSV_FILE = "result.csv"
# --- 設定項目終わり ---

def run_clab_command(container_name, command_list):
    """指定されたコンテナ内でコマンドを実行し、標準出力を返す"""
    # docker exec を直接使う例（Containerlab環境でも通常動作する）
    cmd = ["docker", "exec", container_name] + command_list
    # clab exec を使う場合（トポロジ名が必要になる可能性がある）
    # topology_name = "my_topology" # Containerlabのトポロジ名
    # cmd = ["clab", "exec", "-t", topology_name, f"--label clab-node-name={container_name}", "--"] + command_list
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=MEASUREMENT_INTERVAL_SEC + 10) # タイムアウトを設定
        return result.stdout
    except subprocess.CalledProcessError as e:
        print(f"Error running command {' '.join(command_list)} in {container_name}: {e}")
        print(f"Stderr: {e.stderr}")
        return None
    except subprocess.TimeoutExpired:
        print(f"Timeout running command {' '.join(command_list)} in {container_name}")
        return None
    except FileNotFoundError:
        print("Error: 'docker' command not found. Is Docker installed and in PATH?")
        # clab exec を使う場合は 'clab' not found の可能性もある
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
    """測定結果を指定されたCSVファイルに追記"""
    if value is None: # 値がNoneの場合は記録しない
        return

    file_exists = os.path.isfile(OUTPUT_CSV_FILE)
    try:
        with open(OUTPUT_CSV_FILE, 'a', newline='') as csvfile:
            fieldnames = ['timestamp', 'source_container', 'target_ip', 'metric', 'value']
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)

            if not file_exists or os.path.getsize(OUTPUT_CSV_FILE) == 0:
                writer.writeheader() # ファイルが新規作成または空ならヘッダーを書き込む

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


def main_loop():
    """測定を定期的に実行するメインループ"""
    print(f"Starting network quality monitoring...")
    print(f" Client: {CLIENT_CONTAINER_NAME}")
    print(f" Server: {SERVER_CONTAINER_NAME} ({SERVER_IP})")
    print(f" Interval: {MEASUREMENT_INTERVAL_SEC} seconds")
    print(f" Output file: {OUTPUT_CSV_FILE}")
    print("Press Ctrl+C to stop.")

    #iperf3 サーバーがターゲットで実行されているか簡単なチェック (オプション)
    # print(f"Checking for iperf3 server on {SERVER_CONTAINER_NAME}...")
    # check_cmd = ["pgrep", "iperf3"]
    # server_check = run_clab_command(SERVER_CONTAINER_NAME, check_cmd)
    # if not server_check or server_check.strip() == "":
    #      print(f"Warning: iperf3 server may not be running on {SERVER_CONTAINER_NAME}.")
    #      print(f"Consider running: docker exec {SERVER_CONTAINER_NAME} iperf3 -s -D")

    # boot up iperf3 cmd in SERVER CONTAINER(for background)
    iperf_server_cmd = ["iperf3", "-sD"]
    run_clab_command(SERVER_CONTAINER_NAME, iperf_server_cmd)

    while True:
        current_timestamp = datetime.datetime.now().isoformat(timespec='seconds')
        print(f"\n[{current_timestamp}] Performing measurements...")

        # --- Ping 測定 ---
        ping_cmd = ["ping", "-c", str(PING_COUNT), "-W", "1", SERVER_IP] # -W 1: タイムアウト1秒
        print(f" Executing: {' '.join(ping_cmd)} in {CLIENT_CONTAINER_NAME}")
        ping_result = run_clab_command(CLIENT_CONTAINER_NAME, ping_cmd)
        rtt_avg, loss = parse_ping_output(ping_result)
        print(f"  -> RTT Avg: {rtt_avg} ms, Loss: {loss}%")
        write_log(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_IP, "rtt_avg_ms", rtt_avg)
        write_log(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_IP, "packet_loss_percent", loss)

        # --- iperf3 測定 (TCP スループット) ---
        # TCPがデフォルト
        iperf_tcp_cmd = ["iperf3", "-c", SERVER_IP, "-t", str(IPERF_DURATION_SEC), "-J"] # -J: JSON出力
        print(f" Executing: {' '.join(iperf_tcp_cmd)} in {CLIENT_CONTAINER_NAME}")
        iperf_tcp_result = run_clab_command(CLIENT_CONTAINER_NAME, iperf_tcp_cmd)
        tcp_throughput, _, _, _ = parse_iperf3_json_output(iperf_tcp_result)
        if tcp_throughput is not None:
            tcp_throughput_mbps = tcp_throughput / 1_000_000 # bpsをMbpsに変換
            print(f"  -> TCP Throughput: {tcp_throughput_mbps:.2f} Mbps")
            write_log(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_IP, "tcp_throughput_mbps", round(tcp_throughput_mbps, 2))
        else:
            print("  -> TCP Throughput measurement failed or produced no result.")

        # --- iperf3 測定 (UDP スループット、ジッター、ロス) ---
        # 帯域を指定する必要がある (-b)
        udp_bandwidth = "10M" # 例: 10 Mbps で送信
        iperf_udp_cmd = ["iperf3", "-c", SERVER_IP, "-t", str(IPERF_DURATION_SEC), "-u", "-b", udp_bandwidth, "-J"] # -u: UDPモード, -b: 帯域指定
        print(f" Executing: {' '.join(iperf_udp_cmd)} in {CLIENT_CONTAINER_NAME}")
        iperf_udp_result = run_clab_command(CLIENT_CONTAINER_NAME, iperf_udp_cmd)
        udp_throughput, jitter, lost_pkts, lost_pct = parse_iperf3_json_output(iperf_udp_result)
        if udp_throughput is not None:
            udp_throughput_mbps = udp_throughput / 1_000_000 # bpsをMbpsに変換
            print(f"  -> UDP Throughput: {udp_throughput_mbps:.2f} Mbps (Target: {udp_bandwidth})")
            print(f"  -> UDP Jitter: {jitter} ms")
            print(f"  -> UDP Lost Packets: {lost_pkts} ({lost_pct}%)")
            write_log(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_IP, "udp_throughput_mbps", round(udp_throughput_mbps, 2))
            write_log(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_IP, "udp_jitter_ms", jitter)
            write_log(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_IP, "udp_lost_packets", lost_pkts)
            write_log(current_timestamp, CLIENT_CONTAINER_NAME, SERVER_IP, "udp_lost_percent", lost_pct)
        else:
             print("  -> UDP measurement failed or produced no result.")

       # --- 次の測定まで待機 ---
        print(f"Waiting {MEASUREMENT_INTERVAL_SEC} seconds...")
        time.sleep(MEASUREMENT_INTERVAL_SEC)


#app = Flask(__name__)
app.secret_key = 'your_very_secret_key_here' # flashメッセージのために必要

# グローバル変数で前回のリクエストの結果を保持（簡略化のため）
# 本番環境ではセッションやデータベースを検討
last_detailed_results = None

@app.route('/', methods=['GET'])
def measure():
    global last_detailed_results
    # ページ表示時に前回の詳細結果を渡す
    # flashメッセージは自動でクリアされるが、detailed_resultsは手動でクリア
    results_to_display = last_detailed_results
    last_detailed_results = None # 一度表示したらクリア
    return render_template('measure.html', detailed_results=results_to_display)

@app.route('/run_measures', methods=['POST'])
def run_measures():
    global last_detailed_results
    try:
        print("GUIからLoop実行リクエストを受け付けました。")
        # loop関数を実行
        message, detailed_results = main_loop()
        
        # 結果をflashメッセージとして設定
        if "エラー" in message:
            flash(message, 'error')
        else:
            flash(message, 'success')
        
        # 詳細結果を保存
        last_detailed_results = detailed_results

    except Exception as e:
        # loop関数自体、あるいはその呼び出し周りで予期せぬエラーが起きた場合
        error_msg = f"予期せぬエラーが発生しました: {str(e)}"
        print(error_msg)
        flash(error_msg, 'error')
        last_detailed_results = [{"task": "Application Error", "status": "Failed", "detail": str(e)}]
    
    return redirect(url_for('measure')) # メインページにリダイレクト