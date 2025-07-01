from flask import Flask, jsonify, request
import pandas as pd
from datetime import datetime, timedelta
import os

from ceapp import app


def analyze_data(df: pd.DataFrame):
    """
    ネットワーク通信品質データを分析し、障害発生前後の比較などを行う。

    Args:
        df (pd.DataFrame): 測定データを含むデータフレーム。
                           'timestamp', 'is_injected' および通信品質指標のカラムが必要。

    Returns:
        dict: 分析結果を格納した辞書。
    """
    
    if df.empty:
        return {"message": "No data to analyze."}

    # タイムスタンプでソート
    df['timestamp'] = pd.to_datetime(df['timestamp'])
    df = df.sort_values(by='timestamp').reset_index(drop=True)

    # 障害発生前後でのデータの分割
    # 障害が注入された最初のタイムスタンプを見つける
    first_injection_time = None
    if True in df['is_injected'].values:
        first_injection_time = df[df['is_injected'] == True]['timestamp'].min()

    data_before_injection = pd.DataFrame()
    data_after_injection = pd.DataFrame()
    
    if first_injection_time:
        data_before_injection = df[df['timestamp'] < first_injection_time]
        data_after_injection = df[df['timestamp'] >= first_injection_time]
    else:
        # 障害が一度も注入されていない場合は、全てのデータを「障害前」として扱う
        # または、その旨を通知する
        data_before_injection = df.copy()

    analysis_results = {
        "summary_before_injection": {},
        "summary_after_injection": {},
        "impact_analysis": {},
        "first_injection_time": first_injection_time.isoformat() if first_injection_time else None
    }

    # 主要な通信品質指標
    metrics = [
        'rtt_avg_ms',
        'packet_loss_percent',
        'tcp_throughput_mbps',
        'udp_throughput_mbps',
        'udp_jitter_ms',
        'udp_lost_packets',
        'udp_lost_percent'
    ]

    # 障害発生前の要約統計
    if not data_before_injection.empty:
        for metric in metrics:
            if metric in data_before_injection.columns:
                analysis_results["summary_before_injection"][metric] = {
                    "mean": data_before_injection[metric].mean(),
                    "std": data_before_injection[metric].std(),
                    "min": data_before_injection[metric].min(),
                    "max": data_before_injection[metric].max()
                }

    # 障害発生後の要約統計
    if not data_after_injection.empty:
        for metric in metrics:
            if metric in data_after_injection.columns:
                analysis_results["summary_after_injection"][metric] = {
                    "mean": data_after_injection[metric].mean(),
                    "std": data_after_injection[metric].std(),
                    "min": data_after_injection[metric].min(),
                    "max": data_after_injection[metric].max()
                }

    # 影響分析 (変化率など)
    if not data_before_injection.empty and not data_after_injection.empty:
        for metric in metrics:
            if metric in data_before_injection.columns and metric in data_after_injection.columns:
                before_mean = analysis_results["summary_before_injection"].get(metric, {}).get("mean")
                after_mean = analysis_results["summary_after_injection"].get(metric, {}).get("mean")
                
                if before_mean is not None and after_mean is not None and before_mean != 0:
                    percentage_change = ((after_mean - before_mean) / before_mean) * 100
                    analysis_results["impact_analysis"][metric] = {
                        "change_percent": percentage_change,
                        "change_absolute": after_mean - before_mean
                    }
                elif before_mean == 0 and after_mean != 0:
                     analysis_results["impact_analysis"][metric] = {
                        "change_percent": float('inf'), # 無限大
                        "change_absolute": after_mean
                    }
                else: # both are 0 or before_mean is None
                     analysis_results["impact_analysis"][metric] = {
                        "change_percent": 0.0,
                        "change_absolute": 0.0
                    }
    
    # 相関分析 (例: RTTとパケットロス)
    # これはより詳細な分析で、特定の障害シナリオで有効
    # ここでは例として、全体のデータでの相関を見る
    correlation_matrix = df[metrics].corr().to_dict()
    analysis_results["correlation_matrix"] = correlation_matrix

    return analysis_results

"""
if __name__ == '__main__':
    # テストデータを作成してanalysis.pyを単体テストする例
    test_data = {
        'timestamp': [
            datetime(2025, 6, 28, 10, 50, 40),
            datetime(2025, 6, 28, 10, 50, 44),
            datetime(2025, 6, 28, 10, 51, 32), # 障害発生のポイント
            datetime(2025, 6, 28, 10, 51, 46), # 障害発生中
            datetime(2025, 6, 28, 10, 51, 51), # 障害発生中
            datetime(2025, 6, 28, 10, 52, 27)  # 障害発生中
        ],
        'source_container': ['clab-ospf-pc1'] * 6,
        'target_container': ['clab-ospf-pc2'] * 6,
        'rtt_avg_ms': [0.069, 0.068, 0.086, 0.074, 0.075, 0.078],
        'packet_loss_percent': [0, 0, 0, 0, 0, 0],
        'tcp_throughput_mbps': [7224.7, 14711.79, 10704.21, 12801.42, 15270.69, 15262.9],
        'udp_throughput_mbps': [10.02, 10.05, 9.95, 10.05, 10.04, 10.02],
        'udp_jitter_ms': [1.36, 0.57, 0.10, 0.04, 0.04, 0.23],
        'udp_lost_packets': [0, 0, 17, 5, 0, 0],
        'udp_lost_percent': [0, 0, 12.87, 3.75, 0, 0],
        'is_injected': [False, False, False, True, True, True] # 最初のFalseは障害発生前
    }
    test_df = pd.DataFrame(test_data)
    
    results = analyze_data(test_df)
    import json
    print(json.dumps(results, indent=4))
"""

# --以下API--
@app.route('/api/data', methods=['GET'])
def get_data():
    """
    result.csv からデータを読み込み、JSON形式で返すAPIエンドポイント。
    """
    try:
        # result.csv のパスを適切に設定してください
        # 例: Flaskアプリケーションのルートディレクトリに result.csv がある場合
        # または、result.csv が別の場所にある場合は絶対パスを指定
        csv_file_path = os.path.join(os.path.dirname(__file__), '..', 'result.csv')
        
        if not os.path.exists(csv_file_path):
            return jsonify({"error": f"File not found: {csv_file_path}"}), 404

        df = pd.read_csv(csv_file_path)
        
        # timestamp をISOフォーマットに変換してクライアント側で扱いやすくする
        df['timestamp'] = pd.to_datetime(df['timestamp']).dt.isoformat()
        
        return jsonify(df.to_dict(orient='records'))
    except Exception as e:
        app.logger.error(f"Error loading data: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/analyze', methods=['POST'])
def analyze():
    """
    クライアントから送信されたデータ分析リクエストを処理し、分析結果を返すAPIエンドポイント。
    """
    try:
        data = request.json
        if not data or 'data' not in data:
            return jsonify({"error": "No data provided for analysis"}), 400
        
        # timestamp を datetime オブジェクトに変換
        for row in data['data']:
            row['timestamp'] = datetime.fromisoformat(row['timestamp'])
            
        df = pd.DataFrame(data['data'])
        
        analysis_results = analyze_data(df)
        
        # datetime オブジェクトをJSONシリアライズ可能な形式に変換
        for key, value in analysis_results.items():
            if isinstance(value, pd.DataFrame):
                analysis_results[key] = value.to_dict(orient='records')
            elif isinstance(value, dict):
                for sub_key, sub_value in value.items():
                    if isinstance(sub_value, pd.Timestamp):
                        analysis_results[key][sub_key] = sub_value.isoformat()
        
        return jsonify(analysis_results)
    except Exception as e:
        app.logger.error(f"Error during analysis: {e}")
        return jsonify({"error": str(e)}), 500


