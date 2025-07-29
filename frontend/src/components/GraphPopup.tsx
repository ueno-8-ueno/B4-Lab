import React from 'react';
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
import { Chart } from 'react-chartjs-2';
import annotationPlugin from 'chartjs-plugin-annotation';

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

interface GraphPopupProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  data: any[];
  dataKeys: string[];
  labelKey: string;
  chartType: 'line' | 'bar' | 'scatter';
  xAxisKey?: string;
  yAxisKey?: string;
  trendData?: { slope: number; intercept: number; startX: number; endX: number; firstTimestamp: string }[];
  chartHeight?: number;
  firstInjectionTime?: string | null;
  rawDataVisible?: boolean;
  movingAverageVisible?: boolean;
  onRawDataVisibilityChange?: (visible: boolean) => void;
  onMovingAverageVisibilityChange?: (visible: boolean) => void;
}

const GraphPopup: React.FC<GraphPopupProps> = ({
  isOpen,
  onClose,
  title,
  data,
  dataKeys,
  labelKey,
  chartType,
  xAxisKey,
  yAxisKey,
  trendData,
  chartHeight = 400,
  firstInjectionTime,
  rawDataVisible = true,
  movingAverageVisible = true,
  onRawDataVisibilityChange,
  onMovingAverageVisibilityChange,
}) => {
  if (!isOpen) {
    return null;
  }

  let chartData: any = {};
  let options: any = {};
  const effectiveChartHeight = chartHeight;

  if (chartType === 'line' && xAxisKey && yAxisKey) {
    const datasets = dataKeys.map((key, index) => {
      const isActualRawValueKey = key === 'rawValue';
      const isMovingAverageKey = key === 'movingAverage';

      if ((isActualRawValueKey && !rawDataVisible) || (isMovingAverageKey && !movingAverageVisible)) {
        return null; // 非表示の場合は null を返す
      }

      return {
        label: isActualRawValueKey ? '生データ' : '移動平均',
        data: data.map(item => {
          const val = item?.[key];
          return typeof val === 'number' && (isNaN(val) || !isFinite(val)) ? null : val;
        }),
        borderColor: isActualRawValueKey ? 'rgba(54, 162, 235, 1)' : 'rgba(255, 99, 132, 1)',
        backgroundColor: isActualRawValueKey ? 'rgba(54, 162, 235, 0.2)' : 'rgba(255, 99, 132, 0.2)',
        fill: false,
        tension: isActualRawValueKey ? 0.1 : 0,
        pointRadius: isActualRawValueKey ? 3 : 0,
        pointHoverRadius: isActualRawValueKey ? 5 : 0,
        borderWidth: isActualRawValueKey ? 1 : 2,
      };
    }).filter(dataset => dataset !== null); // null をフィルタリングして非表示のデータセットを除外

    chartData = {
      labels: data.map(item => new Date(item?.[xAxisKey]).toLocaleTimeString()),
      datasets: datasets,
    };

    options = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: {
          display: true,
          text: title,
        },
        legend: {
          display: datasets.length > 1,
        },
        tooltip: {
          mode: 'index' as const,
          intersect: false,
        },
        annotation: firstInjectionTime
          ? {
              annotations: {
                line1: {
                  type: 'line',
                  xMin: new Date(firstInjectionTime).toLocaleTimeString(),
                  xMax: new Date(firstInjectionTime).toLocaleTimeString(),
                  borderColor: 'rgba(255, 0, 0, 0.8)',
                  borderWidth: 2,
                  borderDash: [6, 6],
                  label: {
                    content: '障害発生',
                    enabled: true,
                    position: 'start',
                    backgroundColor: 'rgba(255, 0, 0, 0.7)',
                    color: 'white',
                    font: {
                      size: 10,
                    },
                  },
                },
              },
            }
          : {},
      },
      scales: {
        x: {
          title: {
            display: true,
            text: '時刻',
          },
        },
        y: {
          beginAtZero: false,
          title: {
            display: true,
            text: yAxisKey === 'value' ? '値' : yAxisKey,
          },
        },
      },
    };
  } else if (chartType === 'bar' || chartType === 'scatter') {
    // Bar/Scatter グラフのロジック (変更なし)
    if (chartType === 'scatter' && xAxisKey && yAxisKey) {
      chartData = {
        datasets: [
          {
            label: title,
            data: data
              .map(item => ({
                x: typeof item?.[xAxisKey] === 'number' && !isNaN(item?.[xAxisKey]) && isFinite(item?.[xAxisKey]) ? item?.[xAxisKey] : null,
                y: typeof item?.[yAxisKey] === 'number' && !isNaN(item?.[yAxisKey]) && isFinite(item?.[yAxisKey]) ? item?.[yAxisKey] : null,
              }))
              .filter(point => point.x !== null && point.y !== null),
            backgroundColor: 'rgba(75, 192, 192, 0.6)',
            borderColor: 'rgba(75, 192, 192, 1)',
            pointRadius: 5,
            pointHoverRadius: 7,
            showLine: false,
          },
        ],
      };

      options = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: title,
          },
          tooltip: {
            mode: 'point' as const,
            callbacks: {
              label: function (context: any) {
                return `(${context.raw.x.toFixed(3)}, ${context.raw.y.toFixed(3)})`;
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear' as const,
            position: 'bottom' as const,
            title: {
              display: true,
              text: xAxisKey,
            },
            beginAtZero: false,
          },
          y: {
            type: 'linear' as const,
            position: 'left' as const,
            title: {
              display: true,
              text: yAxisKey,
            },
            beginAtZero: false,
          },
        },
      };
    } else {
      chartData = {
        labels: data.map(item => item?.[labelKey] || ''),
        datasets: dataKeys.map((key, index) => ({
          label: key,
          data: data.map(item => {
            const val = item?.value?.[key] !== undefined ? item?.value?.[key] : item?.[key];
            return typeof val === 'number' && (isNaN(val) || !isFinite(val)) ? null : val;
          }),
          backgroundColor: chartType === 'bar'
            ? [
                'rgba(255, 99, 132, 0.8)',
                'rgba(54, 162, 235, 0.8)',
                'rgba(255, 206, 86, 0.8)',
                'rgba(75, 192, 192, 0.8)',
                'rgba(153, 102, 255, 0.8)',
                'rgba(255, 159, 64, 0.8)',
                'rgba(199, 199, 199, 0.8)',
              ][index % 7]
            : 'rgba(75, 192, 192, 0.8)',
          borderColor: chartType === 'bar'
            ? [
                'rgba(255, 99, 132, 1)',
                'rgba(54, 162, 235, 1)',
                'rgba(255, 206, 86, 1)',
                'rgba(75, 192, 192, 1)',
                'rgba(153, 102, 255, 1)',
                'rgba(255, 159, 64, 1)',
                'rgba(199, 199, 199, 1)',
              ][index % 7]
            : 'rgba(75, 192, 192, 1)',
          borderWidth: 1,
          fill: false,
          tension: 0.1,
        })),
      };

      options = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: title,
          },
          legend: {
            display: dataKeys.length > 1,
          },
          tooltip: {
            mode: 'index' as const,
            intersect: false,
          },
        },
        scales: {
          x: {
            title: {
              display: true,
              text: labelKey === 'label' ? '指標' : '相関係数',
            },
          },
          y: {
            beginAtZero: true,
            title: {
              display: true,
              text: '値',
            },
          },
        },
      };
    }
  }

  const popupOverlayStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
  };

  const popupContentStyle: React.CSSProperties = {
    backgroundColor: 'white',
    padding: '30px',
    borderRadius: '8px',
    boxShadow: '0 4px 15px rgba(0, 0, 0, 0.3)',
    zIndex: 1000,
    maxWidth: '80%',
    maxHeight: '90%',
    overflowY: 'auto',
    minWidth: '400px',
    minHeight: `${effectiveChartHeight + 150}px`, // チェックボックス分の高さも考慮
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  };

  const chartWrapperStyle: React.CSSProperties = {
    flexGrow: 1,
    position: 'relative',
    height: effectiveChartHeight,
    minHeight: effectiveChartHeight,
  };

  const closeButtonStyle: React.CSSProperties = {
    marginTop: '20px',
    padding: '10px 20px',
    backgroundColor: '#007bff',
    color: 'white',
    border: 'none',
    borderRadius: '5px',
    cursor: 'pointer',
    fontSize: '1em',
    alignSelf: 'flex-end',
  };

  const checkboxContainerStyle: React.CSSProperties = {
    display: 'flex',
    gap: '20px',
    alignItems: 'center',
  };

  return (
    <div style={popupOverlayStyle} onClick={onClose}>
      <div style={popupContentStyle} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div style={checkboxContainerStyle}>
          {dataKeys.includes('rawValue') && onRawDataVisibilityChange && (
            <div>
              <input
                type="checkbox"
                id={`${title}-raw-data`}
                checked={rawDataVisible}
                onChange={(e) => onRawDataVisibilityChange(e.target.checked)}
              />
              <label htmlFor={`${title}-raw-data`}>元のデータ</label>
            </div>
          )}
          {dataKeys.includes('movingAverage') && onMovingAverageVisibilityChange && (
            <div>
              <input
                type="checkbox"
                id={`${title}-moving-average`}
                checked={movingAverageVisible}
                onChange={(e) => onMovingAverageVisibilityChange(e.target.checked)}
              />
              <label htmlFor={`${title}-moving-average`}>移動平均</label>
            </div>
          )}
        </div>
        <div style={chartWrapperStyle}>
          <Chart type={chartType} data={chartData} options={options} />
        </div>
        <button onClick={onClose} style={closeButtonStyle}>
          閉じる
        </button>
      </div>
    </div>
  );
};

export default GraphPopup;