import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import AnalysisChart from './components/AnalysisChart'; // 新しいコンポーネントをインポート

// Chart.js のコンポーネントを登録
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
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
  correlation_matrix: { [key: string]: { [key: string]: number } };
  first_injection_time: string | null;
  message?: string; // 分析データがない場合など
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

const AnalysisPage: React.FC = () => {
  const [data, setData] = useState<MeasurementData[]>([]);
  const [analysisResults, setAnalysisResults] = useState<AnalysisResults | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const API_BASE_URL = 'http://localhost:5000/api'; // FlaskサーバーのURL

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        // 測定データを取得
        const dataResponse = await axios.get<MeasurementData[]>(`${API_BASE_URL}/data`);
        setData(dataResponse.data);

        // 分析リクエストを送信
        const analysisResponse = await axios.post<AnalysisResults>(`${API_BASE_URL}/analyze`, {
          data: dataResponse.data,
        });
        setAnalysisResults(analysisResponse.data);

      } catch (err) {
        if (axios.isAxiosError(err)) {
          setError(`データの取得または分析に失敗しました: ${err.message} - ${err.response?.data?.error || '不明なエラー'}`);
        } else {
          setError(`予期せぬエラーが発生しました: ${String(err)}`);
        }
        console.error('API Error:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  if (loading) return <div className="loading">データを読み込み中...</div>;
  if (error) return <div className="error">エラー: {error}</div>;
  if (data.length === 0) return <div className="no-data">表示するデータがありません。</div>;

  const metricsToDisplay = [
    { key: 'rtt_avg_ms', label: '平均RTT (ms)' },
    { key: 'packet_loss_percent', label: 'パケットロス率 (%)' },
    { key: 'tcp_throughput_mbps', label: 'TCP スループット (Mbps)' },
    { key: 'udp_throughput_mbps', label: 'UDP スループット (Mbps)' },
    { key: 'udp_jitter_ms', label: 'UDP ジッター (ms)' },
    { key: 'udp_lost_packets', label: 'UDP ロストパケット数' },
    { key: 'udp_lost_percent', label: 'UDP ロストパケット率 (%)' },
  ];

  return (
    <div className="container">
      <h1>ネットワーク品質劣化パターン分析システム</h1>

      <div className="section">
        <h2>測定データ可視化</h2>
        <p>グラフ上の赤色の点線は、最初の障害が検出された時点を示します。</p>
        <div className="charts-grid">
          {metricsToDisplay.map((metric) => (
            <AnalysisChart
              key={metric.key}
              data={data}
              metricKey={metric.key}
              metricLabel={metric.label}
              firstInjectionTime={analysisResults?.first_injection_time}
            />
          ))}
        </div>
      </div>

      {analysisResults && (
        <div className="analysis-results section">
          <h2>分析結果</h2>
          {analysisResults.message && <p>{analysisResults.message}</p>}

          {analysisResults.first_injection_time && (
            <p>最初の障害注入時刻: {new Date(analysisResults.first_injection_time).toLocaleString()}</p>
          )}

          <h3>通信品質の要約統計 (障害前)</h3>
          {Object.keys(analysisResults.summary_before_injection).length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>指標</th>
                  <th>平均</th>
                  <th>標準偏差</th>
                  <th>最小</th>
                  <th>最大</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(analysisResults.summary_before_injection).map(([metric, summary]) => (
                  <tr key={metric}>
                    <td>{metricsToDisplay.find(m => m.key === metric)?.label || metric}</td>
                    <td>{summary.mean?.toFixed(3)}</td>
                    <td>{summary.std?.toFixed(3)}</td>
                    <td>{summary.min?.toFixed(3)}</td>
                    <td>{summary.max?.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>障害発生前のデータがありません。</p>
          )}

          <h3>通信品質の要約統計 (障害後)</h3>
          {Object.keys(analysisResults.summary_after_injection).length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>指標</th>
                  <th>平均</th>
                  <th>標準偏差</th>
                  <th>最小</th>
                  <th>最大</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(analysisResults.summary_after_injection).map(([metric, summary]) => (
                  <tr key={metric}>
                    <td>{metricsToDisplay.find(m => m.key === metric)?.label || metric}</td>
                    <td>{summary.mean?.toFixed(3)}</td>
                    <td>{summary.std?.toFixed(3)}</td>
                    <td>{summary.min?.toFixed(3)}</td>
                    <td>{summary.max?.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>障害発生後のデータがありません。</p>
          )}

          <h3>障害による影響分析 (平均値の変化)</h3>
          {Object.keys(analysisResults.impact_analysis).length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>指標</th>
                  <th>変化率 (%)</th>
                  <th>絶対的な変化</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(analysisResults.impact_analysis).map(([metric, impact]) => (
                  <tr key={metric}>
                    <td>{metricsToDisplay.find(m => m.key === metric)?.label || metric}</td>
                    <td className={impact.change_percent > 0 ? 'text-danger' : 'text-success'}>
                      {impact.change_percent.toFixed(2)}{impact.change_percent === Infinity ? ' (∞)' : ''}%
                    </td>
                    <td>{impact.change_absolute.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>障害による影響の分析データがありません。</p>
          )}

          <h3>相関行列</h3>
          {analysisResults.correlation_matrix && Object.keys(analysisResults.correlation_matrix).length > 0 ? (
            <div className="correlation-matrix-container">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    {Object.keys(analysisResults.correlation_matrix).map(metric => (
                      <th key={metric}>{metricsToDisplay.find(m => m.key === metric)?.label || metric}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(analysisResults.correlation_matrix).map(([rowMetric, correlations]) => (
                    <tr key={rowMetric}>
                      <td>{metricsToDisplay.find(m => m.key === rowMetric)?.label || rowMetric}</td>
                      {Object.entries(correlations).map(([colMetric, value]) => (
                        <td key={colMetric}>{value.toFixed(3)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>相関分析の結果がありません。</p>
          )}
        </div>
      )}
    </div>
  );
};

export default AnalysisPage;