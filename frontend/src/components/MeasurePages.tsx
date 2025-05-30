import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import LiveMetricsChart, { type MetricDataPoint, METRIC_CONFIGS } from './LiveMetricsChart';

interface ApiProps {
  apiBaseUrl: string;
}

const POLLING_INTERVAL_MS = 5000;
const MAX_CHART_POINTS = 60;

interface MessageState {
  text: string;
  type: 'success' | 'error' | 'info' | 'warning' | ''; // '' を許容
}

const MeasurePage: React.FC<ApiProps> = ({ apiBaseUrl }) => {
  const [isRunning, setIsRunning] = useState(false);
  // isLoading は複数の状態を管理するため、より具体的にする
  const [isLoadingStatus, setIsLoadingStatus] = useState(true); // 測定ステータスのロード中
  const [isOperating, setIsOperating] = useState(false); // Start/Stop操作中
  const [isLoadingChartData, setIsLoadingChartData] = useState(true); // チャートデータロード中

  const [message, setMessage] = useState<MessageState>({ text: '', type: '' });
  const [allMetricsData, setAllMetricsData] = useState<MetricDataPoint[]>([]);
  
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // 既存の fetchStatus を useCallback でラップ
  const fetchMeasurementStatus = useCallback(async () => {
    // 最初のロード時以外は isOperating で制御されているため、setIsLoadingStatus は不要かも
    // if (!isLoadingStatus) setIsLoadingStatus(true); // 必要なら有効化
    try {
      const response = await axios.get<{ is_running: boolean }>(`${apiBaseUrl}/measure/status`);
      setIsRunning(response.data.is_running);
    } catch (error) {
      console.error("Error fetching status:", error);
      setMessage({ text: 'Failed to fetch measurement status.', type: 'error' });
    } finally {
      setIsLoadingStatus(false); // ステータスロード完了
    }
  }, [apiBaseUrl]); // 依存配列は apiBaseUrl のみでOK

  const fetchAndProcessChartData = useCallback(async () => {
    // 初回ロード時またはデータがまだない場合にローディング表示
    if (allMetricsData.length === 0 && !isLoadingChartData) {
        setIsLoadingChartData(true);
    }
    try {
      const response = await axios.get<MetricDataPoint[]>(`${apiBaseUrl}/measure/csv_data`);
      // APIは時系列にソートされたデータを返すか、またはCSVが追記型で自然に時系列になっていることを期待
      setAllMetricsData(response.data || []);
    } catch (error) {
      console.error("Error fetching chart data:", error);
      // エラーメッセージは永続的に表示するより、一時的か、
      // またはデータがない場合のメッセージでカバーする
      // setMessage({ text: 'Failed to load chart data.', type: 'error' });
    } finally {
      setIsLoadingChartData(false);
    }
  }, [apiBaseUrl, allMetricsData.length, isLoadingChartData]);

  useEffect(() => {
    fetchMeasurementStatus();
    fetchAndProcessChartData(); 

    pollingIntervalRef.current = setInterval(() => {
      fetchAndProcessChartData();
    }, POLLING_INTERVAL_MS);

    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
    // fetchMeasurementStatus と fetchAndProcessChartData を依存配列に追加
  }, [fetchMeasurementStatus, fetchAndProcessChartData]); 

  // 既存の handleStart を useCallback でラップし、ローディング状態を管理
  const handleStart = useCallback(async () => {
    setIsOperating(true); // 操作開始
    setMessage({ text: '', type: '' }); // メッセージクリア
    try {
      const response = await axios.post<{ message: string, status: MessageState['type'] }>(
        `${apiBaseUrl}/measure/start`
      );
      setMessage({ text: response.data.message, type: response.data.status || 'info' });
      if (response.data.status === 'success') {
        setIsRunning(true);
        // 開始後すぐにデータ取得を試みる
        setTimeout(fetchAndProcessChartData, 1000); // 1秒後
      }
    } catch (error) {
      console.error("Error starting measurement:", error);
      setMessage({ text: 'Failed to start measurement.', type: 'error' });
    } finally {
      setIsOperating(false); // 操作完了
      // 最終的なステータスを再確認
      // (API呼び出しが非同期なので、setIsRunning(true)が即時反映されない場合があるため)
      fetchMeasurementStatus(); 
    }
  }, [apiBaseUrl, fetchAndProcessChartData, fetchMeasurementStatus]);

  // 既存の handleStop を useCallback でラップし、ローディング状態を管理
  const handleStop = useCallback(async () => {
    setIsOperating(true); // 操作開始
    setMessage({ text: '', type: '' }); // メッセージクリア
    try {
      const response = await axios.post<{ message: string, status: MessageState['type'] }>(
        `${apiBaseUrl}/measure/stop`
      );
      setMessage({ text: response.data.message, type: response.data.status || 'info' });
      // APIのレスポンスに基づいて isRunning を設定
      if (response.data.status === 'success' || response.data.status === 'info' || response.data.status === 'warning') {
         // API側でスレッドが止まっていれば is_running は false になるはず
         // fetchMeasurementStatus で最終確認するため、ここでは直接 isRunning を false にしない方が良い場合も
      }
    } catch (error) {
      console.error("Error stopping measurement:", error);
      setMessage({ text: 'Failed to stop measurement.', type: 'error' });
    } finally {
      setIsOperating(false); // 操作完了
      fetchMeasurementStatus(); // 最終的なステータスを再確認
    }
  }, [apiBaseUrl, fetchMeasurementStatus]);

  const buttonDisabled = isLoadingStatus || isOperating;

  return (
    <div>
      <h1>測定の実行</h1>
      {message.text && (
        <div className={`message ${message.type || 'info'}`}>
          {message.text}
        </div>
      )}
      <div className="button-group">
        <button onClick={handleStart} disabled={isRunning || buttonDisabled}>
          {isOperating && !isRunning ? '開始処理中...' : isRunning ? '実行中...' : '実行'}
        </button>
        <button onClick={handleStop} disabled={!isRunning || buttonDisabled} className="stop-button">
          {isOperating && isRunning ? '停止処理中...' : !isRunning && !isLoadingStatus ? '停止済み' : '停止'}
        </button>
      </div>
       {(isLoadingStatus || isOperating ) && !message.text && <p>サーバーと通信中...</p>}
      
      <div style={{ marginTop: '20px' }}>
        <h2>リアルタイム測定データ</h2>
        
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(450px, 1fr))', gap: '20px' }}>
          {METRIC_CONFIGS.map(config => (
            <LiveMetricsChart
              key={config.key}
              metricConfig={config}
              dataPoints={allMetricsData}
              maxDataPointsToShow={MAX_CHART_POINTS}
            />
          ))}
        </div>
        {!isLoadingChartData && allMetricsData.length === 0 && (
            <p style={{textAlign: 'center', padding: '20px', color: '#777'}}>
                測定データがありません。測定を開始すると、ここにグラフが表示されます。
            </p>
        )}
      </div>

      <p style={{ marginTop: '30px', fontSize: '0.9em', color: '#666' }}>
        注: バックエンドの`print`文による出力は、Flaskサーバーを実行しているターミナル/コンソールに表示されます。
        グラフは {POLLING_INTERVAL_MS / 1000}秒ごとに更新されます。
      </p>
    </div>
  );
};

export default MeasurePage;