import React, { useEffect, useState } from 'react';
import axios from 'axios';
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

interface AnalysisPageProps {
  apiBaseUrl: string;
}
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
  correlation_matrix: { [key: string]: { [key: string]: number | 'NaN' } };
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

  //console.log(analysisResults)//tststs

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const API_BASE_URL = 'http://localhost:5000/api'; // FlaskサーバーのURL

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const dataResponse = await axios.get<MeasurementData[]>(`${API_BASE_URL}/data`);
        setData(dataResponse.data);

        const analysisResponse = await axios.post<any>(`${API_BASE_URL}/analyze`, { // ★any を使うことで柔軟性を高める (一時的)
          data: dataResponse.data,
        });

        // ここで receivedData の型を確認
        const receivedData = analysisResponse.data;
        //console.log("Type of receivedData from axios:", typeof receivedData); // "object" または "string" か？

        let parsedAnalysisResults: AnalysisResults;

        // receivedData が文字列であればJSON.parseでパースする
        if (typeof receivedData === 'string') {
          //console.log("Received data is a string. Attempting to parse JSON.");
          parsedAnalysisResults = JSON.parse(receivedData);
        } else {
          // すでにオブジェクトであればそのまま使用
          //console.log("Received data is already an object.");
          parsedAnalysisResults = receivedData;
        }

        //console.log("Parsed Analysis Results (after potential parse):", parsedAnalysisResults); // ★パース後のオブジェクトを確認
        //console.log("Parsed Analysis Results first_injection_time:", parsedAnalysisResults.first_injection_time); // ★パース後のfirst_injection_timeを確認

        setAnalysisResults(parsedAnalysisResults); // パース後のオブジェクトをステートに設定

      } catch (err) {
        if (axios.isAxiosError(err)) {
          // サーバーからのレスポンスデータが文字列の場合があるため、安全にエラーメッセージを構築
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
      {analysisResults && (
        <div className="analysis-results section">
          <h1>分析結果</h1>
          {analysisResults.message && <p>{analysisResults.message}</p>}

          {analysisResults.first_injection_time && (
            <p>最初の障害注入時刻: {new Date(analysisResults.first_injection_time).toLocaleString()}</p>
          )}

          <h3>通信品質の要約統計 (障害前)</h3>
          {analysisResults?.summary_before_injection && Object.keys(analysisResults.summary_before_injection).length > 0 ? (
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
                    <td>
                      {
                        // summary.mean が null でも undefined でもない、かつ数値であるかを確認
                        summary.mean !== null && summary.mean !== undefined && typeof summary.mean === 'number' && !isNaN(summary.mean)
                          ? summary.mean.toFixed(3)
                          : 'N/A' // または '0.000' など、適切に表示
                      }
                    </td>
                    <td>
                      {
                        summary.std !== null && summary.std !== undefined && typeof summary.std === 'number' && !isNaN(summary.std)
                          ? summary.std.toFixed(3)
                          : 'N/A'
                      }
                    </td>
                    <td>
                      {
                        summary.min !== null && summary.min !== undefined && typeof summary.min === 'number' && !isNaN(summary.min)
                          ? summary.min.toFixed(3)
                          : 'N/A'
                      }
                    </td>
                    <td>
                      {
                        summary.max !== null && summary.max !== undefined && typeof summary.max === 'number' && !isNaN(summary.max)
                          ? summary.max.toFixed(3)
                          : 'N/A'
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>障害発生前のデータがありません。</p>
          )}

          <h3>通信品質の要約統計 (障害後)</h3>
          {analysisResults?.summary_after_injection && Object.keys(analysisResults.summary_after_injection).length > 0 ? (
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
                    <td>
                      {
                        // summary.mean が null でも undefined でもない、かつ数値であるかを確認
                        summary.mean !== null && summary.mean !== undefined && typeof summary.mean === 'number' && !isNaN(summary.mean)
                          ? summary.mean.toFixed(3)
                          : 'N/A' // または '0.000' など、適切に表示
                      }
                    </td>
                    <td>
                      {
                        summary.std !== null && summary.std !== undefined && typeof summary.std === 'number' && !isNaN(summary.std)
                          ? summary.std.toFixed(3)
                          : 'N/A'
                      }
                    </td>
                    <td>
                      {
                        summary.min !== null && summary.min !== undefined && typeof summary.min === 'number' && !isNaN(summary.min)
                          ? summary.min.toFixed(3)
                          : 'N/A'
                      }
                    </td>
                    <td>
                      {
                        summary.max !== null && summary.max !== undefined && typeof summary.max === 'number' && !isNaN(summary.max)
                          ? summary.max.toFixed(3)
                          : 'N/A'
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>障害発生後のデータがありません。</p>
          )}

          <h3>障害による影響分析 (平均値の変化)</h3>
          {analysisResults?.impact_analysis && Object.keys(analysisResults.impact_analysis).length > 0 ? (
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
                    <td className={
                      impact.change_percent !== null && impact.change_percent !== undefined && impact.change_percent > 0
                        ? 'text-danger'
                        : 'text-success'
                    }>
                      {
                        impact.change_percent !== null && impact.change_percent !== undefined && typeof impact.change_percent === 'number' && !isNaN(impact.change_percent)
                          ? (impact.change_percent.toFixed(2) + (impact.change_percent === Infinity ? ' (∞)' : '%'))
                          : 'N/A'
                      }
                    </td>

                    <td>
                      {
                        impact.change_absolute !== null && impact.change_absolute !== undefined && typeof impact.change_absolute === 'number' && !isNaN(impact.change_absolute)
                          ? impact.change_absolute.toFixed(3)
                          : 'N/A'
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>障害による影響の分析データがありません。</p>
          )}

          <h3>相関行列</h3>
          {analysisResults?.correlation_matrix && Object.keys(analysisResults.correlation_matrix).length > 0 ? (
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
                        <td key={colMetric}>
                          {
                            // value が null でも undefined でもない、かつ数値であるかを確認
                            value !== null && value !== undefined && typeof value === 'number' && !isNaN(value)
                              ? value.toFixed(3)
                              : 'N/A'
                          }
                        </td>
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