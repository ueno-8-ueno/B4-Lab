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
  const [isLoadingStatus, setIsLoadingStatus] = useState(true); // 測定ステータスのロード中
  const [isOperating, setIsOperating] = useState(false); // Start/Stop操作中
  const [isLoadingChartData, setIsLoadingChartData] = useState(true); // チャートデータロード中

  const [message, setMessage] = useState<MessageState>({ text: '', type: '' });
  const [allMetricsData, setAllMetricsData] = useState<MetricDataPoint[]>([]);

  const [config, setConfig] = useState<MeasurementConfig>({
    clientContainerName: "clab-ospf-pc1", // 初期値を設定
    serverContainerName: "clab-ospf-pc2", // 初期値を設定
    serverIp: "192.168.12.10",           // 初期値を設定
    measurementIntervalSec: 1,        // 初期値を設定
    pingCount: 10,                     // 初期値を設定
    iperfDurationSec: 1,              // 初期値を設定
  });
  
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchMeasurementStatus = useCallback(async () => {
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
  }, [fetchMeasurementStatus, fetchAndProcessChartData]); 

  const handleConfigChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setConfig(prevConfig => ({
      ...prevConfig,
      // 数値項目は parseInt で変換、不正な場合は 0 または元の値（ここでは 0 に寄せるか、バリデーションを厳密に）
      [name]: name === 'measurementIntervalSec' || name === 'pingCount' || name === 'iperfDurationSec'
               ? parseInt(value, 10) || 1 // 最小値を1とするなど調整可能
               : value,
    }));
  };

  const handleStart = useCallback(async () => {
    setIsOperating(true);
    setMessage({ text: '', type: '' });
    try {
      const response = await axios.post<{ message: string, status: MessageState['type'] }>(
        `${apiBaseUrl}/measure/start`,
        config // フォームから入力された設定値を送信
      );
      setMessage({ text: response.data.message, type: response.data.status || 'info' });
      if (response.data.status === 'success') {
        setIsRunning(true);
        setTimeout(fetchAndProcessChartData, 1000);
      }
    } catch (error) {
      console.error("Error starting measurement:", error);
      setMessage({ text: 'Failed to start measurement.', type: 'error' });
    } finally {
      setIsOperating(false);
      fetchMeasurementStatus(); 
    }
  }, [apiBaseUrl, fetchAndProcessChartData, fetchMeasurementStatus, config]);

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
         // API側でスレッドが止まっていれば is_running は false になる
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
  const formDisabled = isRunning || buttonDisabled;

  return (
    <div>
      <h1>測定の実行</h1>
      {message.text && (
        <div className={`message ${message.type || 'info'}`}>
          {message.text}
        </div>
      )}

      <div className="config-form" style={{ marginBottom: '20px', padding: '15px', border: '1px solid #ddd', borderRadius: '4px' }}>
        <h2>測定設定</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '10px' }}>
          <div>
            <label htmlFor="clientContainerName" style={{ display: 'block', marginBottom: '5px' }}>送信元コンテナ名:</label>
            <input type="text" id="clientContainerName" name="clientContainerName" value={config.clientContainerName} onChange={handleConfigChange} disabled={formDisabled} style={{width: '90%', padding: '8px'}} />
          </div>
          <div>
            <label htmlFor="serverContainerName" style={{ display: 'block', marginBottom: '5px' }}>宛先コンテナ名:</label>
            <input type="text" id="serverContainerName" name="serverContainerName" value={config.serverContainerName} onChange={handleConfigChange} disabled={formDisabled} style={{width: '90%', padding: '8px'}} />
          </div>
          <div>
            <label htmlFor="serverIp" style={{ display: 'block', marginBottom: '5px' }}>宛先IP:</label>
            <input type="text" id="serverIp" name="serverIp" value={config.serverIp} onChange={handleConfigChange} disabled={formDisabled} style={{width: '90%', padding: '8px'}} />
          </div>
          <div>
            <label htmlFor="measurementIntervalSec" style={{ display: 'block', marginBottom: '5px' }}>測定間隔 (sec):</label>
            <input type="number" id="measurementIntervalSec" name="measurementIntervalSec" value={config.measurementIntervalSec} onChange={handleConfigChange} min="1" disabled={formDisabled} style={{width: '90%', padding: '8px'}} />
          </div>
          <div>
            <label htmlFor="pingCount" style={{ display: 'block', marginBottom: '5px' }}>pingカウント数:</label>
            <input type="number" id="pingCount" name="pingCount" value={config.pingCount} onChange={handleConfigChange} min="1" disabled={formDisabled} style={{width: '90%', padding: '8px'}} />
          </div>
          <div>
            <label htmlFor="iperfDurationSec" style={{ display: 'block', marginBottom: '5px' }}>iPerf間隔 (sec):</label>
            <input type="number" id="iperfDurationSec" name="iperfDurationSec" value={config.iperfDurationSec} onChange={handleConfigChange} min="1" disabled={formDisabled} style={{width: '90%', padding: '8px'}} />
          </div>
        </div>
      </div>

      <div className="button-group">
        <button onClick={handleStart} disabled={formDisabled}> {/* 変更: disabled条件を formDisabled に統一 */}
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