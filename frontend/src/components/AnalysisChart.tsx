import React from 'react';
import { Line } from 'react-chartjs-2';
import { ChartData, ChartOptions } from 'chart.js';

interface MeasurementData {
  timestamp: string;
  rtt_avg_ms: number;
  packet_loss_percent: number;
  tcp_throughput_mbps: number;
  udp_throughput_mbps: number;
  udp_jitter_ms: number;
  udp_lost_packets: number;
  udp_lost_percent: number;
  is_injected: boolean;
}

interface DataChartProps {
  data: MeasurementData[];
  metricKey: keyof MeasurementData; // 'rtt_avg_ms', 'packet_loss_percent' など
  metricLabel: string;
  firstInjectionTime: string | null;
}

const DataChart: React.FC<DataChartProps> = ({ data, metricKey, metricLabel, firstInjectionTime }) => {
  const chartData: ChartData<'line'> = {
    labels: data.map(d => new Date(d.timestamp).toLocaleTimeString()),
    datasets: [
      {
        label: metricLabel,
        data: data.map(d => d[metricKey] as number), // 型アサーション
        borderColor: 'rgba(75, 192, 192, 1)',
        backgroundColor: 'rgba(75, 192, 192, 0.2)',
        fill: false,
        tension: 0.1,
      },
    ],
  };

  const chartOptions: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      title: {
        display: true,
        text: metricLabel + 'の推移',
      },
      legend: {
        display: true,
      },
      tooltip: {
        mode: 'index',
        intersect: false,
      },
    },
    scales: {
      x: {
        title: {
          display: true,
          text: '時刻',
        },
      },
      y: {
        title: {
          display: true,
          text: metricLabel,
        },
        beginAtZero: true,
      },
    },
    // 障害注入時点を示す線を追加
    // plugins の 'annotation' は Chart.js のプラグインとして別途インストール・登録が必要な場合があるため、
    // ここでは Chart.js の直接の `options` での対応を考慮します。
    // もしAnnotation Pluginを使用する場合は、npm install chartjs-plugin-annotation と登録が必要です。
    // 簡単な線であれば、Chart.jsの描画コールバックで手動で描画することも可能ですが、
    // まずは視覚的に分かるように色分けなどで対応するのも一案です。
    // 今回は Chart.js の標準機能で提供される `plugins.annotation` を想定せず、
    // 障害発生時点をマークする代わりに、データを分けて描画したり、
    // グラフの背景色を変えるなどで対応することを検討します。
    // ここでは、データセットを分割することで障害前後の色分けを示します。

    // より良い方法は、Chart.js Annotation Pluginを使用することです。
    // インストール: npm install chartjs-plugin-annotation
    // App.tsx で登録: import annotationPlugin from 'chartjs-plugin-annotation'; ChartJS.register(annotationPlugin);

    // そのプラグインを使わない場合は、手動で線を描画するか、データセットを分割して色分けするかです。
    // 以下はChart.js Annotation Pluginを使用する場合のannotations設定例です。
    // plugins: {
    //   annotation: {
    //     annotations: firstInjectionTime ? {
    //       line1: {
    //         type: 'line',
    //         xMin: new Date(firstInjectionTime).toLocaleTimeString(),
    //         xMax: new Date(firstInjectionTime).toLocaleTimeString(),
    //         borderColor: 'rgb(255, 99, 132)',
    //         borderWidth: 2,
    //         label: {
    //           content: '障害発生',
    //           display: true,
    //           position: 'start'
    //         }
    //       }
    //     } : {}
    //   }
    // }
  };

  // 障害注入時点を示す赤い点線を追加するためのプラグインオプションを手動で設定
  // DataChart.tsx または App.tsx 内で ChartJS.register(annotationPlugin) を行う必要があります。
  // ここでは、一旦プラグインを使わない前提で、見た目でわかりやすいようにデータセットを分割する方法を検討します。
  // より高度な可視化のためにはChart.js Annotation Pluginの導入が推奨されます。

  // 簡略化のため、ここでは単純に `firstInjectionTime` を持つプロパティとして渡し、
  // 描画時にその時刻以降のデータポイントに別の色を付けるなどの工夫をします。
  // Chart.js のデータセット内で `segment` を使う方法もありますが、より簡単な例として。

  const datasets = [
    {
      label: metricLabel,
      data: data.map(d => d[metricKey] as number),
      borderColor: 'rgba(75, 192, 192, 1)',
      backgroundColor: 'rgba(75, 192, 192, 0.2)',
      fill: false,
      tension: 0.1,
      pointRadius: 3,
      pointHoverRadius: 5,
    },
  ];

  // 障害注入時点がある場合、その位置に線を描画する処理をplugins.annotationで追加
  const annotations: any = {};
  if (firstInjectionTime) {
    // タイムスタンプのインデックスを見つける
    const injectionIndex = data.findIndex(d => d.timestamp === firstInjectionTime);
    if (injectionIndex !== -1) {
      // Line Annotation を追加
      annotations.firstInjectionLine = {
        type: 'line',
        xMin: new Date(firstInjectionTime).toLocaleTimeString(),
        xMax: new Date(firstInjectionTime).toLocaleTimeString(),
        borderColor: 'rgb(255, 99, 132)', // 赤色
        borderWidth: 2,
        borderDash: [6, 6], // 点線
        label: {
          content: '障害発生',
          enabled: true,
          position: 'start',
          backgroundColor: 'rgba(255, 99, 132, 0.7)',
          color: 'white',
          font: {
            size: 10
          }
        },
      };
    }
  }

  // Chart.js Annotation Plugin を使用するためのオプションを再構成
  const finalChartOptions: ChartOptions<'line'> = {
    ...chartOptions,
    plugins: {
      ...chartOptions.plugins,
      annotation: {
        annotations: annotations
      }
    }
  };


  return (
    <div className="chart-container">
      <Line data={chartData} options={finalChartOptions} />
    </div>
  );
};

export default AnalysisChart;