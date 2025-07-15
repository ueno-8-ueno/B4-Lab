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

// Chart.js のコンポーネントを登録
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
    BarController
);

interface GraphPopupProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    data: any[]; // グラフに表示するデータ
    dataKeys: string[]; // グラフにするデータのキー (例: ['mean', 'std'])
    labelKey: string; // データのラベルとして使うキー (例: 'label' または 'metric')
    chartType: 'line' | 'bar'; // グラフの種類
}

const GraphPopup: React.FC<GraphPopupProps> = ({ isOpen, onClose, title, data, dataKeys, labelKey, chartType }) => {
    if (!isOpen) {
        return null; // ポップアップが閉じている場合は何もレンダリングしない
    }

    // Chart.js 用のデータ構造を構築
    const chartData = {
        // ラベルは `labelKey` に基づいて動的に生成
        labels: data.map(item => item[labelKey] || ''), 
        datasets: dataKeys.map((key, index) => ({
            label: key,
            // データの取得ロジック
            // item.value?.[key] は要約統計や影響分析のようにネストされたデータに対応
            // item?.[key] は相関行列のように直接の値に対応
            data: data.map(item => {
                const val = item.value?.[key] !== undefined ? item.value?.[key] : item?.[key];
                // NaNやInfinityをnullに変換してChart.jsでエラーが出ないようにする
                return (typeof val === 'number' && (isNaN(val) || !isFinite(val))) ? null : val;
            }),
            // 各データセットに異なる色を割り当てる (例として)
            backgroundColor: chartType === 'bar' 
                ? [
                    'rgba(255, 99, 132, 0.8)', 'rgba(54, 162, 235, 0.8)', 'rgba(255, 206, 86, 0.8)',
                    'rgba(75, 192, 192, 0.8)', 'rgba(153, 102, 255, 0.8)', 'rgba(255, 159, 64, 0.8)',
                    'rgba(199, 199, 199, 0.8)'
                ][index % 7]
                : 'rgba(75, 192, 192, 0.8)',
            borderColor: chartType === 'bar' 
                ? [
                    'rgba(255, 99, 132, 1)', 'rgba(54, 162, 235, 1)', 'rgba(255, 206, 86, 1)',
                    'rgba(75, 192, 192, 1)', 'rgba(153, 102, 255, 1)', 'rgba(255, 159, 64, 1)',
                    'rgba(199, 199, 199, 1)'
                ][index % 7]
                : 'rgba(75, 192, 192, 1)',
            borderWidth: 1,
            fill: false, // 折れ線グラフの場合
            tension: 0.1, // 折れ線グラフの場合
        })),
    };

    const options = {
        responsive: true,
        maintainAspectRatio: false, // ポップアップ内でサイズを制御しやすくするため
        plugins: {
            title: {
                display: true,
                text: title,
            },
            legend: {
                display: dataKeys.length > 1, // データセットが複数ある場合に凡例を表示
            },
            tooltip: {
                mode: 'index' as const, // ホバー時に全てのデータセットを表示
                intersect: false,
            },
        },
        scales: {
            x: {
                title: {
                    display: true,
                    text: labelKey === 'label' ? '指標' : '相関係数', // ラベルキーに応じて軸のタイトルを変更
                },
            },
            y: {
                beginAtZero: true,
                title: {
                    display: true,
                    text: '値', // Y軸のタイトル
                },
            },
        },
    };

    const popupOverlayStyle: React.CSSProperties = {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)', // 半透明の背景
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 999, // ポップアップ本体より下
    };

    const popupContentStyle: React.CSSProperties = {
        backgroundColor: 'white',
        padding: '30px',
        borderRadius: '8px',
        boxShadow: '0 4px 15px rgba(0, 0, 0, 0.3)',
        zIndex: 1000,
        maxWidth: '80%',
        maxHeight: '80%',
        overflowY: 'auto', // 内容がはみ出た場合にスクロール
        minWidth: '400px', // 最小幅
        minHeight: '300px', // 最小高さ
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
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
        alignSelf: 'flex-end', // ボタンを右下に配置
    };

    return (
        <div style={popupOverlayStyle} onClick={onClose}> {/* オーバーレイをクリックしても閉じる */}
            <div style={popupContentStyle} onClick={(e) => e.stopPropagation()}> {/* ポップアップ内のクリックは伝播させない */}
                <h3>{title}</h3>
                <div style={{ flexGrow: 1, position: 'relative' }}> {/* グラフが拡大するように */}
                    <Chart type={chartType} data={chartData} options={options} />
                </div>
                <button onClick={onClose} style={closeButtonStyle}>閉じる</button>
            </div>
        </div>
    );
};

export default GraphPopup;