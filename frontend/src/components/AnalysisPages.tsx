// frontend/src/components/AnalysisPages.tsx

import React, { useEffect, useState, useRef } from 'react';
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
//import type { ChartData, ChartOptions } from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import GraphPopup from './GraphPopup';
import '../App.css';

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
}

interface ImpactAnalysis {
  change_percent: number;
  change_absolute: number;
}

interface TimeSeriesAnalysisResult {
  moving_averages: { [key: string]: (number | null)[] };
}

interface AnalysisResults {
  summary_before_injection: { [key: string]: MetricSummary };
  summary_after_injection: { [key: string]: MetricSummary };
  impact_analysis: { [key: string]: ImpactAnalysis };
  time_series_analysis: TimeSeriesAnalysisResult;
  first_injection_time: string | null;
  message?: string;
  raw_data?: MeasurementData[];
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isGraphPopupOpen, setIsGraphPopupOpen] = useState<boolean>(false);
  const [graphPopupTitle, setGraphPopupTitle] = useState<string>('');
  const [graphPopupData, setGraphPopupData] = useState<any[]>([]);
  const [graphPopupDataKeys, setGraphPopupDataKeys] = useState<string[]>([]);
  const [graphPopupLabelKey, setGraphPopupLabelKey] = useState<string>('');
  const [graphPopupChartType, setGraphPopupChartType] = useState<'line' | 'bar' | 'scatter'>('bar');
  const [graphPopupXAxisKey, setGraphPopupXAxisKey] = useState<string>('');
  const [graphPopupYAxisKey, setGraphPopupYAxisKey] = useState<string>('');
  const [graphPopupTrendData, setGraphPopupTrendData] = useState<{slope: number, intercept: number, startX: number, endX: number, firstTimestamp: string}[]>([]);


  const metricsToDisplay = [
    { key: 'rtt_avg_ms', label: '平均 RTT (ms)' },
    { key: 'packet_loss_percent', label: 'ICMPパケット損失率 (%)' },
    { key: 'tcp_throughput_mbps', label: 'TCP スループット (Mbps)' },
    { key: 'udp_throughput_mbps', label: 'UDP スループット (Mbps)' },
    { key: 'udp_jitter_ms', label: 'UDP ジッタ (ms)' },
    { key: 'udp_lost_packets', label: 'UDP 損失パケット数' },
    { key: 'udp_lost_percent', label: 'UDP 損失率 (%)' },
  ];

  const handleOpenGraphPopup = (
    title: string,
    data: any[],
    dataKeys: string[],
    labelKey: string,
    chartType: 'line' | 'bar' | 'scatter' = 'bar',
    xAxisKey?: string,
    yAxisKey?: string,
    trendData?: {slope: number, intercept: number, startX: number, endX: number, firstTimestamp: string}[], // 今回は移動平均をこれとして渡す
    firstInjectionTime?: string | null
  ) => {
    setGraphPopupTitle(title);
    setGraphPopupData(data);
    setGraphPopupDataKeys(dataKeys);
    setGraphPopupLabelKey(labelKey);
    setGraphPopupChartType(chartType);
    setGraphPopupXAxisKey(xAxisKey || '');
    setGraphPopupYAxisKey(yAxisKey || '');
    setGraphPopupTrendData(trendData || []);
    setIsGraphPopupOpen(true);
  };

  const handleCloseGraphPopup = () => {
    setIsGraphPopupOpen(false);
    setGraphPopupTrendData([]);
  };

  const fetchAndAnalyzeData = async (file?: File) => {
    try {
      setLoading(true);
      setError(null);

      let analysisResultFetched: AnalysisResults | null = null;
      let rawDataFetched: MeasurementData[] = [];

      if (file) {
        const formData = new FormData();
        formData.append('file', file);

        const uploadResponse = await axios.post<AnalysisResults>(
          `${apiBaseUrl}/upload_csv_and_analyze`,
          formData,
          { headers: { 'Content-Type': 'multipart/form-data' } }
        );
        analysisResultFetched = uploadResponse.data;
        rawDataFetched = uploadResponse.data.raw_data || [];

      } else {
        const dataResponse = await axios.get<MeasurementData[]>(`${apiBaseUrl}/data`);
        const defaultData = dataResponse.data;
        rawDataFetched = defaultData;

        const analysisResponse = await axios.post<AnalysisResults>(
          `${apiBaseUrl}/analyze`,
          { data: defaultData },
          { headers: { 'Content-Type': 'application/json' } }
        );
        analysisResultFetched = analysisResponse.data;
      }
      
      setData(rawDataFetched);
      setAnalysisResults(analysisResultFetched);

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

  useEffect(() => {
    fetchAndAnalyzeData();
  }, [apiBaseUrl]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0) {
      fetchAndAnalyzeData(event.target.files[0]);
    }
  };

  const handleImportButtonClick = () => {
    fileInputRef.current?.click();
  };

  if (loading) {
    return <div className="loading">データを読み込み中...</div>;
  }

  if (error) {
    return <div>
             <div className="error">エラー: {error}</div>
             <div className="section">
                <input
                  type="file"
                  accept=".csv"
                  onChange={handleFileChange}
                  ref={fileInputRef}
                  style={{ display: 'none' }}
                />
                <button className="import-button" onClick={handleImportButtonClick}>
                  CSVファイルをインポート
                </button>
              </div>
           </div>;
  }

  if (!analysisResults) {
    return <div>
             <div className="no-data">分析結果がありません。</div>
             <div className="section">
                <input
                  type="file"
                  accept=".csv"
                  onChange={handleFileChange}
                  ref={fileInputRef}
                  style={{ display: 'none' }}
                />
                <button className="import-button" onClick={handleImportButtonClick}>
                  CSVファイルをインポート
                </button>
              </div>
           </div>;
  }

  // 時系列グラフ表示の関数 (移動平均の表示も含む)
  const renderTimeSeriesGraphWithMA = (metricKey: string) => {
    const metricLabel = metricsToDisplay.find(m => m.key === metricKey)?.label || metricKey;
    
    const rawMetricData = data.map(d => ({
        timestamp: d.timestamp,
        value: d[metricKey as keyof MeasurementData]
    })).filter(item => typeof item.value === 'number' && !isNaN(item.value) && isFinite(item.value as number));

    if (rawMetricData.length === 0) {
        alert(`${metricLabel} の時系列グラフを表示できる有効なデータがありません。`);
        return;
    }

    const maBefore = analysisResults.time_series_analysis.moving_averages[`${metricKey}_before`];
    const maAfter = analysisResults.time_series_analysis.moving_averages[`${metricKey}_after`];

    const graphData = rawMetricData.map((d, index) => {
        let maValue: number | null = null;
        if (analysisResults.first_injection_time && d.timestamp < analysisResults.first_injection_time) {
            if (maBefore && index < maBefore.length) {
                maValue = maBefore[index] !== null && typeof maBefore[index] === 'number' && !isNaN(maBefore[index] as number) ? maBefore[index] as number : null;
            }
        } else {
            const firstInjectionIndex = data.findIndex(item => item.timestamp === analysisResults.first_injection_time);
            if (firstInjectionIndex !== -1 && maAfter) {
                // 障害後のインデックスを調整。maAfterは障害後データの先頭からのインデックス
                const maIndex = index - firstInjectionIndex;
                if (maIndex >= 0 && maIndex < maAfter.length) {
                    maValue = maAfter[maIndex] !== null && typeof maAfter[maIndex] === 'number' && !isNaN(maAfter[maIndex] as number) ? maAfter[maIndex] as number : null;
                }
            }
        }
        return {
            timestamp: d.timestamp,
            rawValue: d.value,
            movingAverage: maValue,
        };
    });

    handleOpenGraphPopup(
        `時系列推移 (MA付き): ${metricLabel}`,
        graphData,
        ['rawValue', 'movingAverage'],
        'timestamp',
        'line',
        'timestamp',
        'value',
        undefined, // trendData (今回は使わない)
        analysisResults.first_injection_time
    );
  };


  return (
    <div className="container">
      <h1>分析結果</h1>

      <div className="section">
        <input
          type="file"
          accept=".csv"
          onChange={handleFileChange}
          ref={fileInputRef}
          style={{ display: 'none' }}
        />
        <button className="import-button" onClick={handleImportButtonClick}>
          CSVファイルをインポート
        </button>
        <p>※ファイルをインポートしない場合、デフォルトの `result.csv` が使用されます。</p>
      </div>

      <div className="section">
        <h2>時系列推移 (移動平均)</h2>
        <p>各指標のボタンをクリックすると、時間経過に伴う値の変化と<strong>移動平均</strong>が表示されます。</p>
        <div className="time-series-buttons">
          {metricsToDisplay.map(metric => (
            <button key={`ts-ma-${metric.key}`} onClick={() => renderTimeSeriesGraphWithMA(metric.key)}>
              {metric.label}の推移とMA
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        <h2>要約統計 (障害生成前 / 障害生成後)</h2>
        <table>
          <thead>
            <tr>
              <th>指標</th>
              <th>平均 (前 / 後 (変化率) )</th>
              <th>標準偏差 (前 / 後)</th>
              <th>グラフ (平均)</th>
              <th>グラフ (標準偏差)</th>
            </tr>
          </thead>
          <tbody>
            {metricsToDisplay.map(metric => {
              const summaryBefore = analysisResults.summary_before_injection?.[metric.key];
              const summaryAfter = analysisResults.summary_after_injection?.[metric.key];

              const meanBefore = summaryBefore?.mean !== null && summaryBefore?.mean !== undefined && typeof summaryBefore.mean === 'number' && !isNaN(summaryBefore.mean) && isFinite(summaryBefore.mean) ? summaryBefore.mean.toFixed(3) : 'N/A';
              const meanAfter = summaryAfter?.mean !== null && summaryAfter?.mean !== undefined && typeof summaryAfter.mean === 'number' && !isNaN(summaryAfter.mean) && isFinite(summaryAfter.mean) ? summaryAfter.mean.toFixed(3) : 'N/A';

              let percentageChange: number | null = null;
              if (summaryBefore?.mean !== 0 && typeof summaryBefore?.mean === 'number' && typeof summaryAfter?.mean === 'number') {
                percentageChange = ((summaryAfter.mean - summaryBefore.mean) / summaryBefore.mean) * 100;
              } else if (summaryBefore?.mean === 0 && typeof summaryAfter?.mean === 'number' && summaryAfter.mean !== 0) {
                percentageChange = Infinity;
              } else {
                percentageChange = 0;
              }
              const changeText = percentageChange !== null && isFinite(percentageChange) ? ` (${percentageChange.toFixed(2)}%)` : (percentageChange === Infinity ? ' (∞%)' : ' (0.00%)');

              const stdBefore = summaryBefore?.std !== null && summaryBefore?.std !== undefined && typeof summaryBefore.std === 'number' && !isNaN(summaryBefore.std) && isFinite(summaryBefore.std) ? summaryBefore.std.toFixed(3) : 'N/A';
              const stdAfter = summaryAfter?.std !== null && summaryAfter?.std !== undefined && typeof summaryAfter.std === 'number' && !isNaN(summaryAfter.std) && isFinite(summaryAfter.std) ? summaryAfter.std.toFixed(3) : 'N/A';

              return (
                <tr key={metric.key}>
                  <td>{metric.label}</td>
                  <td className="combined-cell">
                    <span className="value-before">{meanBefore}</span>
                    <span className="separator"> / </span>
                    <span className="value-after">{meanAfter}</span>
                    <span className="change-percent">{changeText}</span>
                  </td>
                  <td className="combined-cell">
                    <span className="value-before">{stdBefore}</span>
                    <span className="separator"> / </span>
                    <span className="value-after">{stdAfter}</span>
                  </td>
                  <td>
                    <button onClick={() => {
                      const chartData = [
                        { label: '障害前', value: summaryBefore?.mean },
                        { label: '障害後', value: summaryAfter?.mean },
                      ].filter(item => typeof item.value === 'number' && !isNaN(item.value) && isFinite(item.value));
                      handleOpenGraphPopup(`平均: ${metric.label}`, chartData, ['value'], 'label', 'bar');
                    }}>表示</button>
                  </td>
                  <td>
                    <button onClick={() => {
                      const chartData = [
                        { label: '障害前', value: summaryBefore?.std },
                        { label: '障害後', value: summaryAfter?.std },
                      ].filter(item => typeof item.value === 'number' && !isNaN(item.value) && isFinite(item.value));
                      handleOpenGraphPopup(`標準偏差: ${metric.label}`, chartData, ['value'], 'label', 'bar');
                    }}>表示</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* グラフポップアップコンポーネント */}
      <GraphPopup
        isOpen={isGraphPopupOpen}
        onClose={handleCloseGraphPopup}
        title={graphPopupTitle}
        data={graphPopupData}
        dataKeys={graphPopupDataKeys}
        labelKey={graphPopupLabelKey}
        chartType={graphPopupChartType}
        xAxisKey={graphPopupXAxisKey}
        yAxisKey={graphPopupYAxisKey}
        trendData={graphPopupTrendData}
        chartHeight={400}
        firstInjectionTime={analysisResults?.first_injection_time}
      />
    </div>
  );
};

export default AnalysisPage;