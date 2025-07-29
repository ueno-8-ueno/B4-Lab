from ceapp import app

import pandas as pd
from datetime import datetime, timedelta
import logging
import numpy as np
from flask import Flask, jsonify, request
from io import StringIO
import os

logging.basicConfig(level=logging.INFO)

# 共通のシリアライズ関数
def serialize_value(value):
    # 数値型の場合の処理
    if isinstance(value, (int, float, np.integer, np.floating)):
        if np.isnan(value) or np.isinf(value):
            return None  # NaN や Infinity は JSON では null に変換
        else:
            return float(value) # float型に統一して返す
    # datetime型の場合
    elif isinstance(value, datetime):
        return value.isoformat()
    # Pandas Timestamp (NaTも含む) の場合
    elif isinstance(value, pd.Timestamp):
        if pd.isna(value): # そのTimestampがNaTかどうかをチェック
            return None  # NaT は None に変換
        else:
            return value.isoformat() # 有効なTimestampはISOフォーマットに変換
    # NumPy配列の場合
    elif isinstance(value, np.ndarray):
        return value.tolist()
    # 辞書の場合
    elif isinstance(value, dict):
        return {k: serialize_value(v) for k, v in value.items()}
    # リストの場合
    elif isinstance(value, list):
        return [serialize_value(elem) for elem in value]
    # Pandas DataFrameの場合（このルートは通常は通らないはずだが、安全のため）
    elif isinstance(value, pd.DataFrame):
        return value.to_dict(orient='records')
    # ブーリアン型の場合
    elif isinstance(value, bool) or isinstance(value, np.bool_):
        return bool(value)
    # その他の型（文字列など）はそのまま返す
    else:
        return value

# 時系列解析：移動平均
def calculate_moving_average(series: pd.Series, window: int):
    # NaNをスキップして計算するために min_periods=1 を設定
    return series.rolling(window=window, min_periods=1).mean()


def analyze_data(df: pd.DataFrame):
    logging.info("Starting analysis_data function.")
    # logging.info(f"Input DataFrame head:\n{df.head()}") # 詳細ログは省略
    # logging.info(f"Input DataFrame info:\n{df.info()}") # 詳細ログは省略

    if df.empty:
        logging.warning("DataFrame is empty. Returning early.")
        return {"message": "No data to analyze."}

    df['timestamp'] = pd.to_datetime(df['timestamp'], errors='coerce')
    df = df.dropna(subset=['timestamp'])

    df = df.sort_values(by='timestamp').reset_index(drop=True)
    # logging.info(f"DataFrame after sorting:\n{df.head()}") # 詳細ログは省略

    first_injection_time = None
    if df['is_injected'].any(): # .any() でブーリアン評価
        first_injection_time = df[df['is_injected'] == True]['timestamp'].min()
    
    logging.info(f"First injection time: {first_injection_time}")

    data_before_injection = pd.DataFrame()
    data_after_injection = pd.DataFrame()
    
    if first_injection_time:
        data_before_injection = df[df['timestamp'] < first_injection_time].copy()
        data_after_injection = df[df['timestamp'] >= first_injection_time].copy()
    else:
        data_before_injection = df.copy()
        logging.warning("No 'is_injected=True' found. All data treated as 'before injection'.")

    logging.info(f"Data before injection shape: {data_before_injection.shape}")
    logging.info(f"Data after injection shape: {data_after_injection.shape}")

    analysis_results = {
        "summary_before_injection": {},
        "summary_after_injection": {},
        "impact_analysis": {},
        "time_series_analysis": { # ★追加：時系列解析のトップレベルキー
            "moving_averages": {},
            # "autocorrelations": {} # 自己相関は今回は削除
        },
        # "correlation_matrix": {}, # ★削除
        "first_injection_time": first_injection_time.isoformat() if first_injection_time else None,
        "raw_data": df.to_dict(orient='records') # フロントエンドに生のデータも返す
    }

    metrics = [
        'rtt_avg_ms', 'packet_loss_percent', 'tcp_throughput_mbps',
        'udp_throughput_mbps', 'udp_jitter_ms', 'udp_lost_packets', 'udp_lost_percent'
    ]

    moving_average_window = 3 # 移動平均のウィンドウサイズ（例：3点移動平均）


    for metric in metrics:
        if metric in df.columns:

            # 障害発生前の要約統計
            if not data_before_injection.empty:
                analysis_results["summary_before_injection"][metric] = {
                    "mean": data_before_injection[metric].mean(),
                    "std": data_before_injection[metric].std(),
                    # "min": data_before_injection[metric].min(), # ★削除
                    # "max": data_before_injection[metric].max() # ★削除
                }
                # 移動平均（障害前）
                ma_before = calculate_moving_average(data_before_injection[metric], moving_average_window)
                analysis_results["time_series_analysis"]["moving_averages"][f"{metric}_before"] = ma_before.tolist()
            else:
                analysis_results["time_series_analysis"]["moving_averages"][f"{metric}_before"] = []


            # 障害発生後の要約統計
            if not data_after_injection.empty:
                analysis_results["summary_after_injection"][metric] = {
                    "mean": data_after_injection[metric].mean(),
                    "std": data_after_injection[metric].std(),
                    # "min": data_after_injection[metric].min(), # ★削除
                    # "max": data_after_injection[metric].max() # ★削除
                }
                # 移動平均（障害後）
                ma_after = calculate_moving_average(data_after_injection[metric], moving_average_window)
                analysis_results["time_series_analysis"]["moving_averages"][f"{metric}_after"] = ma_after.tolist()
            else:
                analysis_results["time_series_analysis"]["moving_averages"][f"{metric}_after"] = []

    # 影響分析 (変化率など) は既存のまま
    if not data_before_injection.empty and not data_after_injection.empty:
        for metric in metrics:
            if metric in df.columns:
                before_mean = analysis_results["summary_before_injection"].get(metric, {}).get("mean")
                after_mean = analysis_results["summary_after_injection"].get(metric, {}).get("mean")
                
                if before_mean is not None and after_mean is not None:
                    if before_mean != 0:
                        percentage_change = ((after_mean - before_mean) / before_mean) * 100
                        analysis_results["impact_analysis"][metric] = {
                            "change_percent": percentage_change,
                            "change_absolute": after_mean - before_mean
                        }
                    elif before_mean == 0 and after_mean != 0:
                        analysis_results["impact_analysis"][metric] = {
                            "change_percent": float('inf'),
                            "change_absolute": after_mean
                        }
                    else:
                        analysis_results["impact_analysis"][metric] = {
                            "change_percent": 0.0,
                            "change_absolute": 0.0
                        }
                else:
                    logging.warning(f"Means for {metric} are None, cannot calculate impact.")
    
    logging.info("Analysis_data function finished.")
    return analysis_results


# Flask API エンドポイント (analysis.py内に直接記述)

# Default data endpoint
@app.route('/api/data', methods=['GET'])
def get_default_data():
    try:
        # result.csv のパスはリポジトリのルートにあると仮定
        csv_file_path = os.path.join(os.path.dirname(__file__), '..', '..', 'result.csv')
        
        app.logger.info(f"Attempting to load default CSV from: {csv_file_path}")

        if not os.path.exists(csv_file_path):
            app.logger.error(f"File DOES NOT EXIST: {csv_file_path}")
            return jsonify({"error": f"Default file not found: {csv_file_path}"}), 404

        df = pd.read_csv(csv_file_path)
        app.logger.info("CSV loaded successfully with pandas.read_csv")
        
        df = df.replace(r'^\s*$', np.nan, regex=True)
        app.logger.info("Blank cells replaced with NaN.")

        df['is_injected'] = df['is_injected'].astype(str).str.lower().map({'true': True, 'false': False}).fillna(False)
        app.logger.info("is_injected column processed.")
        
        metrics = [
            'rtt_avg_ms', 'packet_loss_percent', 'tcp_throughput_mbps',
            'udp_throughput_mbps', 'udp_jitter_ms', 'udp_lost_packets', 'udp_lost_percent'
        ]
        for metric in metrics:
            if metric in df.columns:
                df[metric] = pd.to_numeric(df[metric], errors='coerce')
                df[metric] = df[metric].astype(float)
        app.logger.info("Numeric columns processed.")

        df['timestamp'] = pd.to_datetime(df['timestamp'], errors='coerce')
        app.logger.info("Timestamp column processed.")
        app.logger.info(f"DataFrame info after processing before jsonify:\n{df.info(verbose=True)}")
        app.logger.info(f"DataFrame dtypes before jsonify:\n{df.dtypes}")
        
        return jsonify(serialize_value(df.to_dict(orient='records')))
    except Exception as e:
        app.logger.error(f"Error loading default data in get_default_data: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

# Analyze JSON data endpoint
@app.route('/api/analyze', methods=['POST'])
def analyze_json_data():
    try:
        if not request.is_json:
            app.logger.error("Request is not JSON for /analyze.")
            return jsonify({"error": "Request must be JSON"}), 400

        data = request.json
        app.logger.info(f"Received JSON data for /analyze: {data}")

        if not data or 'data' not in data:
            app.logger.warning("No 'data' key in received JSON or JSON is empty for /analyze.")
            return jsonify({"error": "No data provided for analysis or malformed JSON"}), 400
        
        metrics = [
            'rtt_avg_ms', 'packet_loss_percent', 'tcp_throughput_mbps',
            'udp_throughput_mbps', 'udp_jitter_ms', 'udp_lost_packets', 'udp_lost_percent'
        ]

        processed_data_for_df = []
        for row_dict in data['data']:
            processed_row = {}
            for key, value in row_dict.items():
                if key == 'timestamp':
                    processed_row[key] = datetime.fromisoformat(value) if value is not None else None
                elif key in metrics:
                    if value is None or (isinstance(value, str) and value.strip() == ''):
                        processed_row[key] = np.nan
                    elif isinstance(value, (int, float)):
                        if np.isnan(value) or np.isinf(value):
                            processed_row[key] = np.nan
                        else:
                            processed_row[key] = float(value)
                    else:
                        try:
                            processed_row[key] = float(value)
                        except (ValueError, TypeError):
                            processed_row[key] = np.nan
                else:
                    processed_row[key] = value 
            processed_data_for_df.append(processed_row)
        
        if not processed_data_for_df:
            app.logger.warning("Processed data is empty, cannot create DataFrame for /analyze.")
            return jsonify({"message": "No valid data to analyze after processing."}), 200
            
        df = pd.DataFrame(processed_data_for_df)
        
        if 'is_injected' in df.columns:
            df['is_injected'] = df['is_injected'].astype(bool)

        app.logger.info(f"DataFrame dtypes for /analyze:\n{df.dtypes}")
        app.logger.info(f"DataFrame null counts for /analyze:\n{df.isnull().sum()}")

        analysis_results = analyze_data(df)
        
        return jsonify(serialize_value(analysis_results))
    except Exception as e:
        app.logger.error(f"Error in /analyze endpoint: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

# Upload CSV endpoint
@app.route('/api/upload_csv_and_analyze', methods=['POST'])
def upload_csv_and_analyze():
    try:
        if 'file' not in request.files:
            app.logger.warning("No file part in the request for /upload_csv_and_analyze.")
            return jsonify({"error": "No file part"}), 400

        file = request.files['file']
        if file.filename == '':
            app.logger.warning("No selected file for /upload_csv_and_analyze.")
            return jsonify({"error": "No selected file"}), 400

        if file and file.filename.endswith('.csv'):
            csv_data = StringIO(file.read().decode('utf-8'))
            df = pd.read_csv(csv_data)

            # 堅牢なデータ変換ロジック
            df = df.replace(r'^\s*$', np.nan, regex=True)
            df['is_injected'] = df['is_injected'].astype(str).str.lower().map({'true': True, 'false': False}).fillna(False)
            metrics = ['rtt_avg_ms', 'packet_loss_percent', 'tcp_throughput_mbps', 'udp_throughput_mbps', 'udp_jitter_ms', 'udp_lost_packets', 'udp_lost_percent']
            for metric in metrics:
                if metric in df.columns:
                    df[metric] = pd.to_numeric(df[metric], errors='coerce')
                    df[metric] = df[metric].astype(float)
            df['timestamp'] = pd.to_datetime(df['timestamp'], errors='coerce')

            app.logger.info(f"Uploaded CSV file processed. DataFrame dtypes:\n{df.dtypes}")
            app.logger.info(f"Uploaded CSV file null counts:\n{df.isnull().sum()}")

            analysis_results = analyze_data(df)
            
            return jsonify(serialize_value(analysis_results))

        app.logger.warning(f"Invalid file type uploaded to /upload_csv_and_analyze: {file.filename}")
        return jsonify({"error": "Invalid file type. Please upload a CSV file."}), 400

    except Exception as e:
        app.logger.error(f"Error in /upload_csv_and_analyze endpoint: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, port=5000)