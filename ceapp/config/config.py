# --- 設定項目(measure.py) ---
# Containerlabで起動したコンテナ名に合わせて変更
CLIENT_CONTAINER_NAME = "r1"  # 例: clab-topo-client
SERVER_CONTAINER_NAME = "r4"  # 例: clab-topo-server

# サーバーコンテナのIPアドレス (Containerlabの定義から取得するのが望ましいが、ここでは固定値とする)
SERVER_IP = "2001:db8:7::2" # 例: サーバーコンテナに割り当てられたIP

MEASUREMENT_INTERVAL_SEC = 1  # 測定間隔（秒）
PING_COUNT = 1                # pingの試行回数
IPERF_DURATION_SEC = 10       # iperf3の測定時間（秒）
OUTPUT_CSV_FILE = "result.csv"
# --- 設定項目(measure.py)終わり ---