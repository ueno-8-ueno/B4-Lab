import React, { useEffect, useState } from 'react';
import axios from 'axios';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  LineController,
  BarController,
} from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import GraphPopup from './GraphPopup';

// Chart.js のコンポーネントとコントローラーを登録
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  LineController,
  BarController,
  annotationPlugin
);

interface MetricSummary {
  mean: number;
  std: number;
  min: number;
  max: number;
}

interface ImpactAnalysis {
  change_percent: number;
  change_absolute: number;
}

interface AnalysisResults {
  summary_before_injection: { [key: string]: MetricSummary };
  summary_after_injection: { [key: string]: MetricSummary };
  impact_analysis: { [key: string]: ImpactAnalysis };
  correlation_matrix: { [key: string]: { [key: string]: number | null } };
  first_injection_time: string | null;
  message?: string;
}

interface MeasurementData {
  timestamp: string;
  source_container: string;
  target_container: string;
  rtt_avg_ms: number;
  packet_loss_percent: number;
  tcp_throughput_mbps: number;
  udp_throughput_mbps: number;
  udp_jitter_ms: number;
  udp_lost_packets: number;
  udp_lost_percent: number;
  is_injected: boolean;
}

interface AnalysisPageProps {
  apiBaseUrl: string;
}

const AnalysisPage: React.FC<AnalysisPageProps> = ({ apiBaseUrl }) => {
  const [data, setData] = useState<MeasurementData[]>([]);
  const [analysisResults, setAnalysisResults] = useState<AnalysisResults | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // グラフポップアップの状態管理
  const [isGraphPopupOpen, setIsGraphPopupOpen] = useState<boolean>(false);
  const [graphPopupTitle, setGraphPopupTitle] = useState<string>('');
  const [graphPopupData, setGraphPopupData] = useState<any[]>([]);
  const [graphPopupDataKeys, setGraphPopupDataKeys] = useState<string[]>([]);
  const [graphPopupLabelKey, setGraphPopupLabelKey] = useState<string>('');
  const [graphPopupChartType, setGraphPopupChartType] = useState<'line' | 'bar'>('bar');

  const metricsToDisplay = [
    { key: 'rtt_avg_ms', label: '平均 RTT (ms)' },
    { key: 'packet_loss_percent', label: 'パケット損失率 (%)' },
    { key: 'tcp_throughput_mbps', label: 'TCP スループット (Mbps)' },
    { key: 'udp_throughput_mbps', label: 'UDP スループット (Mbps)' },
    { key: 'udp_jitter_ms', label: 'UDP ジッタ (ms)' },
    { key: 'udp_lost_packets', label: 'UDP 損失パケット数' },
    { key: 'udp_lost_percent', label: 'UDP 損失率 (%)' },
  ];

  // グラフポップアップを開く関数
  const handleOpenGraphPopup = (
    title: string,
    data: any[],
    dataKeys: string[],
    labelKey: string,
    chartType: 'line' | 'bar' = 'bar'
  ) => {
    setGraphPopupTitle(title);
    setGraphPopupData(data);
    setGraphPopupDataKeys(dataKeys);
    setGraphPopupLabelKey(labelKey);
    setGraphPopupChartType(chartType);
    setIsGraphPopupOpen(true);
  };

  // グラフポップアップを閉じる関数
  const handleCloseGraphPopup = () => {
    setIsGraphPopupOpen(false);
  };

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const dataResponse = await axios.get<MeasurementData[]>(`${apiBaseUrl}/data`);
        setData(dataResponse.data);

        const analysisResponse = await axios.post<any>(`${apiBaseUrl}/analyze`, {
          data: dataResponse.data,
        });

        const receivedData = analysisResponse.data;
        let parsedAnalysisResults: AnalysisResults;

        if (typeof receivedData === 'string') {
          parsedAnalysisResults = JSON.parse(receivedData);
        } else {
          parsedAnalysisResults = receivedData;
        }

        setAnalysisResults(parsedAnalysisResults);

      } catch (err) {
        if (axios.isAxiosError(err)) {
          const errorMessage = err.response?.data ?
            (typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data)) :
            err.message;
          setError(`データの取得または分析に失敗しました: ${errorMessage}`);
        } else {
          setError(`予期せぬエラーが発生しました: ${String(err)}`);
        }
        console.error('API Error:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [apiBaseUrl]);

  if (loading) {
    return <div className="loading">データを読み込み中...</div>;
  }

  if (error) {
    return <div className="error">エラー: {error}</div>;
  }

  if (!analysisResults) {
    return <div className="no-data">分析結果がありません。</div>;
  }

  return (
    <div className="container">
      <h1>分析結果</h1>

      {/* 障害発生前の要約統計 */}
      {analysisResults.summary_before_injection && Object.keys(analysisResults.summary_before_injection).length > 0 ? (
        <div className="section">
          <h2>通信品質の要約統計 (障害前)</h2>
          <table>
            <thead>
              <tr>
                <th>指標</th>{/* 空白防止 */}
                <th>平均</th>{/* 空白防止 */}
                <th>標準偏差</th>{/* 空白防止 */}
                <th>最小</th>{/* 空白防止 */}
                <th>最大</th>{/* 空白防止 */}
                <th>グラフ</th>{/* 空白防止 */}
              </tr>
            </thead>
            <tbody>
              {Object.entries(analysisResults.summary_before_injection).map(([metric, summary]) => (
                <tr key={metric}>
                  <td>{metricsToDisplay.find(m => m.key === metric)?.label || metric}</td>
                  <td>
                    {summary.mean !== null && summary.mean !== undefined && typeof summary.mean === 'number' && !isNaN(summary.mean)
                      ? summary.mean.toFixed(3)
                      : 'N/A'}
                  </td>
                  <td>
                    {summary.std !== null && summary.std !== undefined && typeof summary.std === 'number' && !isNaN(summary.std)
                      ? summary.std.toFixed(3)
                      : 'N/A'}
                  </td>
                  <td>
                    {summary.min !== null && summary.min !== undefined && typeof summary.min === 'number' && !isNaN(summary.min)
                      ? summary.min.toFixed(3)
                      : 'N/A'}
                  </td>
                  <td>
                    {summary.max !== null && summary.max !== undefined && typeof summary.max === 'number' && !isNaN(summary.max)
                      ? summary.max.toFixed(3)
                      : 'N/A'}
                  </td>
                  <td>
                    <button onClick={() => {
                      const metricLabel = metricsToDisplay.find(m => m.key === metric)?.label || metric;
                      const chartData = [
                        { label: '平均', value: summary.mean },
                        { label: '標準偏差', value: summary.std },
                        { label: '最小', value: summary.min },
                        { label: '最大', value: summary.max },
                      ].filter(item => typeof item.value === 'number' && !isNaN(item.value) && isFinite(item.value)); // 有効な数値のみフィルタリング

                      handleOpenGraphPopup(`障害前要約: ${metricLabel}`, chartData, ['value'], 'label', 'bar');
                    }}>表示</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="section">
          <h2>通信品質の要約統計 (障害前)</h2>
          <p>障害発生前のデータがありません。</p>
        </div>
      )}

      {/* 障害発生後の要約統計 */}
      {analysisResults.summary_after_injection && Object.keys(analysisResults.summary_after_injection).length > 0 ? (
        <div className="section">
          <h2>通信品質の要約統計 (障害後)</h2>
          <table>
            <thead>
              <tr>
                <th>指標</th>{/* 空白防止 */}
                <th>平均</th>{/* 空白防止 */}
                <th>標準偏差</th>{/* 空白防止 */}
                <th>最小</th>{/* 空白防止 */}
                <th>最大</th>{/* 空白防止 */}
                <th>グラフ</th>{/* 空白防止 */}
              </tr>
            </thead>
            <tbody>
              {Object.entries(analysisResults.summary_after_injection).map(([metric, summary]) => (
                <tr key={metric}>
                  <td>{metricsToDisplay.find(m => m.key === metric)?.label || metric}</td>
                  <td>
                    {summary.mean !== null && summary.mean !== undefined && typeof summary.mean === 'number' && !isNaN(summary.mean)
                      ? summary.mean.toFixed(3)
                      : 'N/A'}
                  </td>
                  <td>
                    {summary.std !== null && summary.std !== undefined && typeof summary.std === 'number' && !isNaN(summary.std)
                      ? summary.std.toFixed(3)
                      : 'N/A'}
                  </td>
                  <td>
                    {summary.min !== null && summary.min !== undefined && typeof summary.min === 'number' && !isNaN(summary.min)
                      ? summary.min.toFixed(3)
                      : 'N/A'}
                  </td>
                  <td>
                    {summary.max !== null && summary.max !== undefined && typeof summary.max === 'number' && !isNaN(summary.max)
                      ? summary.max.toFixed(3)
                      : 'N/A'}
                  </td>
                  <td>
                    <button onClick={() => {
                      const metricLabel = metricsToDisplay.find(m => m.key === metric)?.label || metric;
                      const chartData = [
                        { label: '平均', value: summary.mean },
                        { label: '標準偏差', value: summary.std },
                        { label: '最小', value: summary.min },
                        { label: '最大', value: summary.max },
                      ].filter(item => typeof item.value === 'number' && !isNaN(item.value) && isFinite(item.value)); // 有効な数値のみフィルタリング

                      handleOpenGraphPopup(`障害後要約: ${metricLabel}`, chartData, ['value'], 'label', 'bar');
                    }}>表示</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="section">
          <h2>通信品質の要約統計 (障害後)</h2>
          <p>障害発生後のデータがありません。</p>
        </div>
      )}

      {/* 影響分析 */}
      {analysisResults.impact_analysis && Object.keys(analysisResults.impact_analysis).length > 0 ? (
        <div className="section">
          <h2>障害による影響分析 (平均値の変化)</h2>
          <table>
            <thead>
              <tr>
                <th>指標</th>{/* 空白防止 */}
                <th>変化率 (%)</th>{/* 空白防止 */}
                <th>絶対的な変化</th>{/* 空白防止 */}
                <th>グラフ</th>{/* 空白防止 */}
              </tr>
            </thead>
            <tbody>
              {Object.entries(analysisResults.impact_analysis).map(([metric, impact]) => (
                <tr key={metric}>
                  <td>{metricsToDisplay.find(m => m.key === metric)?.label || metric}</td>
                  <td className={
                    impact.change_percent !== null && impact.change_percent !== undefined && typeof impact.change_percent === 'number' && !isNaN(impact.change_percent) && isFinite(impact.change_percent)
                      ? (impact.change_percent > 0 ? 'text-danger' : 'text-success')
                      : ''
                  }>
                    {
                      impact.change_percent !== null && impact.change_percent !== undefined && typeof impact.change_percent === 'number' && !isNaN(impact.change_percent) && isFinite(impact.change_percent)
                        ? (impact.change_percent.toFixed(2) + (impact.change_percent === Infinity ? ' (∞)' : '%'))
                        : 'N/A'
                    }
                  </td>
                  <td>
                    {
                      impact.change_absolute !== null && impact.change_absolute !== undefined && typeof impact.change_absolute === 'number' && !isNaN(impact.change_absolute) && isFinite(impact.change_absolute)
                        ? impact.change_absolute.toFixed(3)
                        : 'N/A'
                    }
                  </td>
                  <td>
                    <button onClick={() => {
                      const metricLabel = metricsToDisplay.find(m => m.key === metric)?.label || metric;
                      const chartData = [
                        { label: '変化率 (%)', value: impact.change_percent },
                        { label: '絶対的な変化', value: impact.change_absolute },
                      ].filter(item => typeof item.value === 'number' && !isNaN(item.value) && isFinite(item.value)); // 有効な数値のみフィルタリング

                      handleOpenGraphPopup(`影響分析: ${metricLabel}`, chartData, ['value'], 'label', 'bar');
                    }}>表示</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="section">
          <h2>障害による影響分析 (平均値の変化)</h2>
          <p>障害による影響の分析データがありません。</p>
        </div>
      )}

      {/* 相関行列 */}
      {analysisResults.correlation_matrix && Object.keys(analysisResults.correlation_matrix).length > 0 ? (
        <div className="section">
          <h2>相関行列</h2>
          <div className="correlation-matrix-container">
            <table>
              <thead>
                <tr>
                  <th>指標</th>{/* 空白防止 */}
                  {Object.keys(analysisResults.correlation_matrix).map(metric => (
                    <th key={metric}>{metricsToDisplay.find(m => m.key === metric)?.label || metric}</th>
                  ))}
                  <th>グラフ</th>{/* 空白防止 */}
                </tr>
              </thead>
              <tbody>
                {Object.entries(analysisResults.correlation_matrix).map(([rowMetric, correlations]) => (
                  <tr key={rowMetric}>
                    <td>{metricsToDisplay.find(m => m.key === rowMetric)?.label || rowMetric}</td>{/* 行の指標ラベルを表示 */}
                    {Object.entries(correlations).map(([colMetric, value]) => (
                      <td key={colMetric}>
                        {typeof value === 'number' && !isNaN(value) ? value.toFixed(3) : 'N/A'}
                      </td>
                    ))}
                    <td>
                      <button onClick={() => {
                        const rowMetricLabel = metricsToDisplay.find(m => m.key === rowMetric)?.label || rowMetric;
                        // 選択された行の相関係数をグラフ表示用に整形
                        const chartData = Object.entries(correlations).map(([colMetric, value]) => ({
                          label: metricsToDisplay.find(m => m.key === colMetric)?.label || colMetric,
                          correlation: value
                        })).filter(item => typeof item.correlation === 'number' && !isNaN(item.correlation) && isFinite(item.filter(Boolean))); // 有効な数値のみフィルタリング

                        handleOpenGraphPopup(`相関: ${rowMetricLabel} との相関`, chartData, ['correlation'], 'label', 'bar');
                      }}>表示</button>
                    </td>{/* 空白防止 */}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="section">
          <h2>相関行列</h2>
          <p>相関分析の結果がありません。</p>
        </div>
      )}

      {/* グラフポップアップコンポーネント */}
      <GraphPopup
        isOpen={isGraphPopupOpen}
        onClose={handleCloseGraphPopup}
        title={graphPopupTitle}
        data={graphPopupData}
        dataKeys={graphPopupDataKeys}
        labelKey={graphPopupLabelKey}
        chartType={graphPopupChartType}
      />
    </div>
  );
};

export default AnalysisPage;