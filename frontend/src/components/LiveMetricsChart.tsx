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
  TimeScale
} from 'chart.js';
import type { ChartData as ChartJsChartData, ChartOptions as ChartJsChartOptions } from 'chart.js';
import 'chartjs-adapter-date-fns';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  TimeScale
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

type MetricKey = typeof METRIC_CONFIGS[number]['key'];

interface LiveMetricsChartProps {
  metricConfig: typeof METRIC_CONFIGS[number];
  dataPoints: MetricDataPoint[];
  maxDataPointsToShow?: number;
}

// Chart.js のデータ型をより具体的に指定
// TChartType は 'line', 'bar', 'pie' など
// TData はデータポイントの型 (例: number | null)
// TLabel はラベルの型 (例: string)
type LineChartData = ChartJsChartData<'line', (number | null)[], string>;
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
    labels: processedDataPoints.map(dp => dp.timestamp),
    datasets: [
      {
        label: metricConfig.label,
        data: processedDataPoints.map(dp => dp[metricConfig.key]),
        borderColor: metricConfig.color,
        backgroundColor: metricConfig.color.replace('rgb', 'rgba').replace(')', ', 0.2)'),
        fill: true,
        tension: 0.1,
        pointRadius: 2,
        pointHoverRadius: 5,
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
    animation: { duration: 200 },
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