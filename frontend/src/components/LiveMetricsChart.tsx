import React from 'react';
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
  TimeScale,
  Filler,
} from 'chart.js';
import type { ChartData as ChartJsChartData, ChartOptions as ChartJsChartOptions, ScriptableContext } from 'chart.js'; // ScriptableContext追加
import 'chartjs-adapter-date-fns';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  TimeScale,
  Filler
);

export interface MetricDataPoint {
  timestamp: string;
  source_container?: string;
  target_container?: string;
  rtt_avg_ms: number | null;
  packet_loss_percent: number | null;
  tcp_throughput_mbps: number | null;
  udp_throughput_mbps: number | null;
  udp_jitter_ms: number | null;
  udp_lost_packets: number | null;
  udp_lost_percent: number | null;
  is_injected?: boolean;
}

export const METRIC_CONFIGS = [
  { key: 'rtt_avg_ms', label: 'RTT (ms)', color: 'rgb(255, 99, 132)' },
  { key: 'packet_loss_percent', label: 'Packet Loss (%)', color: 'rgb(54, 162, 235)' },
  { key: 'tcp_throughput_mbps', label: 'TCP Throughput (Mbps)', color: 'rgb(255, 206, 86)' },
  { key: 'udp_throughput_mbps', label: 'UDP Throughput (Mbps)', color: 'rgb(75, 192, 192)' },
  { key: 'udp_jitter_ms', label: 'UDP Jitter (ms)', color: 'rgb(153, 102, 255)' },
  { key: 'udp_lost_packets', label: 'UDP Lost Packets', color: 'rgb(255, 159, 64)' },
  { key: 'udp_lost_percent', label: 'UDP Lost Percent (%)', color: 'rgb(199, 199, 199)' },
] as const;

// type MetricKey = typeof METRIC_CONFIGS[number]['key']; // 必要であれば型エイリアス

interface LiveMetricsChartProps {
  metricConfig: typeof METRIC_CONFIGS[number];
  dataPoints: MetricDataPoint[];
  maxDataPointsToShow?: number;
}

type LineChartData = ChartJsChartData<'line', (number | null)[], string>; // または Date
type LineChartOptions = ChartJsChartOptions<'line'>; 

const LiveMetricsChart: React.FC<LiveMetricsChartProps> = ({
  metricConfig,
  dataPoints,
  maxDataPointsToShow = 100,
}) => {
  const processedDataPoints = dataPoints
    .slice(-maxDataPointsToShow)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const chartData: LineChartData = {
    labels: processedDataPoints.map(dp => dp.timestamp), // タイムスタンプをDateオブジェクトに変換しても良い
    datasets: [
      {
        label: metricConfig.label,
        data: processedDataPoints.map(dp => dp[metricConfig.key]),
        borderColor: metricConfig.color,
        // --- is_injectedフラグで色分け ---
        backgroundColor: (context: ScriptableContext<'line'>) => {
          const chart = context.chart;
          const { ctx, chartArea } = chart;
          if (!chartArea) {
            return metricConfig.color.replace('rgb', 'rgba').replace(')', ', 0.1)'); // デフォルトの薄い色
          }
          // is_injected に基づいてグラデーションや単色塗り分けを実装できる
          // ここでは単純に is_injected フラグを持つ最初のデータポイントを探し、
          // それ以降の背景色を変える例 (より洗練された方法も可能)
          
          // この方法はデータポイントごとの背景色なので、エリア全体ではなく線の下になる。
          // エリア全体の色を変えるには、annotationプラグインか、
          // データセットを分割するなどの工夫が必要。
          // 今回はデータポイントの色変更で示す (より簡単なアプローチ)
          // または、セグメントスタイリング (v3.7.0+) を使う。

          // 簡単な実装: is_injectedがtrueのデータポイントでは色を変える
          // ただし、これは点の色。エリアはfill:trueで全体が塗られる。
          // エリアの色分けは annotation プラグインが適している。
          // ここでは、fill: false にして線の色だけにするか、
          // もしくは annotation プラグインの導入を検討する。
          // 今回は annotation プラグインは導入せず、fill: true で薄い背景色のままにする。
          // is_injected の視覚化は、例えばデータポイントの色を変えるなどで対応もできる。
          
          // セグメントスタイリングの例 (線色を部分的に変える)
          // segment: {
          //   borderColor: ctx => processedDataPoints[ctx.p0DataIndex]?.is_injected ? 'rgba(255, 0, 0, 0.5)' : undefined,
          //   backgroundColor: ctx => processedDataPoints[ctx.p0DataIndex]?.is_injected ? 'rgba(255, 0, 0, 0.1)' : undefined,
          // },
          // spanGaps: true, // 欠損データがあっても線を繋ぐ

          // 今回はシンプルに、datasets全体で一つの背景色とする
          return metricConfig.color.replace('rgb', 'rgba').replace(')', ', 0.2)');
        },
        // --- 変更終わり ---
        fill: true, // エリアを塗る
        tension: 0.1,
        pointRadius: 2,
        pointHoverRadius: 5,
        pointBackgroundColor: processedDataPoints.map(dp => dp.is_injected ? 'red' : metricConfig.color),
        pointBorderColor: processedDataPoints.map(dp => dp.is_injected ? 'darkred' : metricConfig.color),
      },
    ],
  };

  const chartOptions: LineChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: true, position: 'top' as const },
      title: { display: true, text: metricConfig.label, font: { size: 16 } },
      tooltip: { mode: 'index', intersect: false },
      // --- 追加: annotation プラグインを使う場合の準備 (今回は導入しないが参考) ---
      // annotation: {
      //   annotations: processedDataPoints.reduce((acc, dp, index) => {
      //     if (dp.is_injected && (index === 0 || !processedDataPoints[index-1].is_injected)) {
      //       // 障害開始点
      //       acc[`faultStart-${index}`] = {
      //         type: 'box',
      //         xMin: dp.timestamp,
      //         xMax: processedDataPoints[processedDataPoints.length - 1].timestamp, // 最後まで
      //         yMin: (ctx) => ctx.chart.chartArea?.bottom, // Y軸の範囲は動的に
      //         yMax: (ctx) => ctx.chart.chartArea?.top,
      //         backgroundColor: 'rgba(255, 0, 0, 0.05)', // 薄い赤背景
      //         borderColor: 'rgba(255,0,0,0.1)',
      //         borderWidth: 1,
      //       };
      //     }
      //     return acc;
      //   }, {}),
      // }
      // --- 追加終わり ---
    },
    scales: {
      x: {
        type: 'time',
        time: {
          unit: 'second',
          tooltipFormat: 'yyyy-MM-dd HH:mm:ss',
          displayFormats: { second: 'HH:mm:ss', minute: 'HH:mm', hour: 'HH:00' },
        },
        title: { display: false },
        ticks: { maxTicksLimit: 10, autoSkip: true }
      },
      y: {
        beginAtZero: true,
        title: { display: false },
        ticks: { precision: 2 }
      },
    },
    animation: { duration: 0 }, // リアルタイム更新なのでアニメーションはオフが良い
  };

  if (processedDataPoints.length === 0) {
    return (
      <div style={{ height: '300px', border: '1px solid #eee', padding: '10px', borderRadius: '5px', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#f9f9f9' }}>
        <p>No data available for {metricConfig.label}</p>
      </div>
    );
  }

  return (
    <div style={{ height: '300px', border: '1px solid #eee', padding: '10px', borderRadius: '5px', backgroundColor: '#fff' }}>
      <Line options={chartOptions} data={chartData} />
    </div>
  );
};

export default LiveMetricsChart;