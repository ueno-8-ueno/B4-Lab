import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

interface MessageState {
  text: string;
  type: 'success' | 'error' | 'info' | 'warning' | '';
}

interface InjectPageProps {
  apiBaseUrl: string;
}

interface TopologyData {
  containers: string[];
  links: string[][];
  interfaces_by_container: Record<string, string[]>;
}

const InjectPage: React.FC<InjectPageProps> = ({ apiBaseUrl }) => {
  const [containers, setContainers] = useState<string[]>([]);
  const [links, setLinks] = useState<string[][]>([]);
  const [interfacesByContainer, setInterfacesByContainer] = useState<Record<string, string[]>>({});
  const [selectedNodeInterfaces, setSelectedNodeInterfaces] = useState<string[]>([]);

  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<MessageState>({ text: '', type: '' });

  const [faultType, setFaultType] = useState('link_down');
  
  const [targetNode, setTargetNode] = useState(''); 
  const [targetInterface, setTargetInterface] = useState(''); 

  const [targetLink, setTargetLink] = useState('');

  const [latencyMs, setLatencyMs] = useState<string | number>(100);
  const [jitterMs, setJitterMs] = useState<string | number>('');
  const [correlationPercent, setCorrelationPercent] = useState<string | number>('');

  const [bandwidthRateKbit, setBandwidthRateKbit] = useState<string | number>(1000);
  const [bandwidthBurstBytes, setBandwidthBurstBytes] = useState<string | number>('');
  const [bandwidthLatencyMs, setBandwidthLatencyMs] = useState<string | number>('50');


  const fetchTopology = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await axios.get<TopologyData>(
        `${apiBaseUrl}/insert/topology`
      );
      const fetchedContainers = response.data.containers || [];
      const fetchedSimpleLinks = response.data.links || [];
      const fetchedInterfaces = response.data.interfaces_by_container || {};

      setContainers(fetchedContainers);
      setLinks(fetchedSimpleLinks);
      setInterfacesByContainer(fetchedInterfaces);

      if (fetchedContainers.length > 0) {
        const firstContainer = fetchedContainers[0];
        setTargetNode(firstContainer);
        const firstNodeInterfaces = fetchedInterfaces[firstContainer] || [];
        setSelectedNodeInterfaces(firstNodeInterfaces);
        if (firstNodeInterfaces.length > 0) {
            setTargetInterface(firstNodeInterfaces[0]);
        } else {
            setTargetInterface(''); // インターフェースがない場合は空に
        }
      } else { // コンテナがない場合のリセット
        setTargetNode('');
        setSelectedNodeInterfaces([]);
        setTargetInterface('');
      }

      if (fetchedSimpleLinks.length > 0) {
        setTargetLink(`${fetchedSimpleLinks[0][0]}|${fetchedSimpleLinks[0][1]}`);
      } else {
        setTargetLink('');
      }
    } catch (error) {
      console.error("Error fetching topology:", error);
      setMessage({ text: 'Failed to fetch topology data.', type: 'error' });
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    fetchTopology();
  }, [fetchTopology]);

  useEffect(() => {
    if (targetNode && interfacesByContainer[targetNode]) {
      const nodeInterfaces = interfacesByContainer[targetNode];
      setSelectedNodeInterfaces(nodeInterfaces);
      if (nodeInterfaces.length > 0) {
        // 現在選択されているIFが新しいリストに存在するか確認
        if (!nodeInterfaces.includes(targetInterface)) {
          setTargetInterface(nodeInterfaces[0]); // 存在しなければ先頭を選択
        }
        // 存在すれば現在の選択を維持 (何もしない)
      } else {
        setTargetInterface(''); 
      }
    } else {
      setSelectedNodeInterfaces([]);
      setTargetInterface('');
    }
  }, [targetNode, interfacesByContainer, targetInterface]); // targetInterface を依存配列から削除すると無限ループの可能性あり、注意


  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setMessage({ text: '', type: '' });

    // --- 修正: payloadに含めるtarget_nodeを障害タイプに応じて決定 ---
    let nodeForCommand = targetNode; // デフォルト
    if (faultType.includes('link_')) {
        if (!targetLink) {
            setMessage({ text: 'Target link must be selected for link operations.', type: 'error'});
            setIsLoading(false);
            return;
        }
        // link_down/up の場合、target_node が空ならリンクの片側（例: 左側）を操作対象とする
        // target_node がユーザーによって明示的に選択されていればそちらを優先
        nodeForCommand = targetNode || targetLink.split('|')[0];
    }
    // --- 修正終わり ---


    const payload: any = {
      fault_type: faultType,
      target_node: nodeForCommand, // --- 修正: 実際にコマンドが実行されるノード ---
      target_interface: targetInterface,
    };

    if (faultType.includes('link_')) {
      payload.target_link = targetLink; // target_linkは情報として送信
    } else if (faultType === 'add_latency') {
      payload.latency_ms = Number(latencyMs);
      if (jitterMs) payload.jitter_ms = Number(jitterMs);
      if (correlationPercent) payload.correlation_percent = Number(correlationPercent);
    } else if (faultType === 'limit_bandwidth') {
      payload.bandwidth_rate_kbit = Number(bandwidthRateKbit);
      if (bandwidthBurstBytes) payload.bandwidth_burst_bytes = String(bandwidthBurstBytes);
      if (bandwidthLatencyMs) payload.bandwidth_latency_ms = String(bandwidthLatencyMs);
    }

    // --- 追加: tc_clear と node_* 障害では target_interface は不要な場合があるので削除 ---
    if (faultType === 'tc_clear') {
        // target_node と target_interface は必要
    } else if (faultType.includes('node_')) {
        delete payload.target_interface; // node_stop などではIFは不要
    }
    // --- 追加終わり ---


    try {
      const response = await axios.post<{ message: string, status: MessageState['type'] }>(
        `${apiBaseUrl}/insert/fault`, payload
      );
      setMessage({ text: response.data.message, type: response.data.status || 'info' });
    } catch (error: any) {
      console.error("Error injecting fault:", error);
      setMessage({ text: 'Failed to inject fault. ' + (error.response?.data?.message || error.message) , type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  // フォーム表示制御
  const showLinkTargetFields = faultType === 'link_down' || faultType === 'link_up'; // リンク選択フィールド用
  // ターゲットノードは、リンクダウン/アップ以外では必須、リンクダウン/アップでは任意（片側IF操作のため）
  const showNodeSelector = faultType !== 'link_down' && faultType !== 'link_up'; // tc系、node系
  const showInterfaceSelector = faultType === 'add_latency' || faultType === 'limit_bandwidth' || faultType === 'tc_clear' || faultType === 'link_down' || faultType === 'link_up';

  const showLatencyParams = faultType === 'add_latency';
  const showBandwidthParams = faultType === 'limit_bandwidth';


  if (isLoading && containers.length === 0 && links.length === 0) {
    return <p>Loading topology data...</p>;
  }

  return (
    <div>
      <h1>障害生成画面</h1>
      {message.text && (
        <div className={`message ${message.type || 'info'}`}>
          {message.text}
        </div>
      )}

      <h2>検出したトポロジ</h2>
      <h3>コンテナ一覧:</h3>
      {containers.length > 0 ? (
        containers.map(container => <div className="container" key={container}>{container}</div>)
      ) : (
        <p>コンテナが検出されませんでした (またはDockerエラー).</p>
      )}

      <h3>仮想リンク一覧 (推定):</h3>
      {links.length > 0 ? (
        links.map(link => <div className="link" key={`${link[0]}-${link[1]}`}>{`${link[0]} <--> ${link[1]}`}</div>)
      ) : (
        <p>コンテナ間のリンクが検出されません.</p>
      )}

      <div className="form-section">
        <h2>障害生成</h2>
        <form onSubmit={handleSubmit}>
          <div>
            <label htmlFor="fault_type">障害パターン:</label>
            <select id="fault_type" name="fault_type" value={faultType} onChange={e => {
              setFaultType(e.target.value);
              // 障害タイプ変更時にターゲットノードのインターフェースを再評価
              if (containers.length > 0) {
                  const currentTargetNode = targetNode || containers[0]; // 現在のノードまたは先頭ノード
                  const nodeInterfaces = interfacesByContainer[currentTargetNode] || [];
                  setSelectedNodeInterfaces(nodeInterfaces);
                  if (nodeInterfaces.length > 0) {
                      setTargetInterface(nodeInterfaces[0]);
                  } else {
                      setTargetInterface('');
                  }
              }
            }}>
              <option value="link_down">Link Down</option>
              <option value="link_up">Link Up</option>
              <option value="node_stop">Node Stop</option>
              <option value="node_start">Node Start</option>
              <option value="node_pause">Node Pause</option>
              <option value="node_unpause">Node Unpause</option>
              <option value="add_latency">Add Latency (tc netem)</option>
              <option value="limit_bandwidth">Limit Bandwidth (tc tbf)</option>
              <option value="tc_clear">Clear TC Rules (on interface)</option>
            </select>
          </div>

          {/* ターゲットノード選択 (リンク操作以外で表示、またはリンク操作でも任意で表示) */}
          {/* tc操作やnode操作では必須。link操作では、ここで選択したノードのIFを操作する */}
          {(showNodeSelector || showLinkTargetFields) && ( // リンク操作時もノード選択を表示する
            <div>
              <label htmlFor="target_node">ターゲットノード:</label>
              <select 
                id="target_node" 
                name="target_node" 
                value={targetNode} 
                onChange={e => setTargetNode(e.target.value)} 
                disabled={containers.length === 0}
              >
                {/* リンク操作の場合、未選択も許容するならオプションを追加 */}
                {/* <option value="">-- Select Node (for Link Op Optional) --</option> */}
                {containers.map(container => (
                  <option key={`node-target-${container}`} value={container}>{container}</option>
                ))}
              </select>
            </div>
          )}

          {/* ターゲットインターフェース選択 (ドロップダウンのみ) */}
          {showInterfaceSelector && (
             <div>
                <label htmlFor="target_interface">ターゲットインターフェース:</label>
                <select 
                    id="target_interface" 
                    name="target_interface" 
                    value={targetInterface} 
                    onChange={e => setTargetInterface(e.target.value)} 
                    disabled={selectedNodeInterfaces.length === 0} // 選択可能なIFがなければ無効
                >
                    {selectedNodeInterfaces.length === 0 && <option value="">-- Select Node First or No Interfaces --</option>}
                    {selectedNodeInterfaces.map(ifName => (
                        <option key={`if-${targetNode}-${ifName}`} value={ifName}>{ifName}</option>
                    ))}
                </select>
             </div>
          )}

          {showLinkTargetFields && (
            <div id="link_target_specific">
              <div>
                <label htmlFor="target_link">ターゲットリンク (ノードペア):</label>
                <select id="target_link" name="target_link" value={targetLink} onChange={e => setTargetLink(e.target.value)} disabled={links.length === 0}>
                  {links.map(link => (
                    <option key={`${link[0]}|${link[1]}`} value={`${link[0]}|${link[1]}`}>
                      {`${link[0]} <--> ${link[1]}`}
                    </option>
                  ))}
                </select>
                 <p style={{fontSize: "0.8em", color: "#666", marginLeft: "155px"}}>
                    Link Down/Upは、上記「ターゲットノード」で選択されたノードの「ターゲットインターフェース」に対して実行されます。
                    ターゲットノードが未選択の場合、このリンクの左側のノードが対象になります。
                </p>
              </div>
            </div>
          )}
          
          {showLatencyParams && (
            <div id="latency_params">
              <div>
                <label htmlFor="latency_ms">遅延 (ms):</label>
                <input type="number" id="latency_ms" value={latencyMs} onChange={e => setLatencyMs(e.target.value === '' ? '' : Number(e.target.value))} min="1" required />
              </div>
              <div>
                <label htmlFor="jitter_ms">ジッター (ms, 任意):</label>
                <input type="number" id="jitter_ms" value={jitterMs} onChange={e => setJitterMs(e.target.value === '' ? '' : Number(e.target.value))} min="0" />
              </div>
              <div>
                <label htmlFor="correlation_percent">相関 (% , 任意):</label>
                <input type="number" id="correlation_percent" value={correlationPercent} onChange={e => setCorrelationPercent(e.target.value === '' ? '' : Number(e.target.value))} min="0" max="100" />
              </div>
            </div>
          )}

          {showBandwidthParams && (
            <div id="bandwidth_params">
              <div>
                <label htmlFor="bandwidth_rate_kbit">レート (kbit/s):</label>
                <input type="number" id="bandwidth_rate_kbit" value={bandwidthRateKbit} onChange={e => setBandwidthRateKbit(e.target.value === '' ? '' : Number(e.target.value))} min="1" required />
              </div>
              <div>
                <label htmlFor="bandwidth_burst_bytes">バースト (bytes, 任意):</label>
                <p>(短期間のトラフィック急増の最大許容値)</p>
                <input type="text" id="bandwidth_burst_bytes" value={bandwidthBurstBytes} onChange={e => setBandwidthBurstBytes(e.target.value)} placeholder="e.g., 32000 or 32kb" />
              </div>
              <div>
                <label htmlFor="bandwidth_latency_ms">TBFレイテンシ (ms, 任意):</label>
                <p>(指定した時間内に送信できないトラフィックはドロップ)</p>
                <input type="text" id="bandwidth_latency_ms" value={bandwidthLatencyMs} onChange={e => setBandwidthLatencyMs(e.target.value)} placeholder="e.g., 50ms" />
              </div>
            </div>
          )}
          
          <br/>
          <button type="submit" disabled={isLoading}>障害生成実行</button>
        </form>
      </div>
    </div>
  );
}

export default InjectPage;