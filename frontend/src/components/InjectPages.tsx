import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

interface MessageState {
  text: string;
  type: 'success' | 'error' | 'info' | 'warning' | '';
}
interface DetailedMessage {
    fault_type: string;
    status: string;
    message: string;
    target_display: string;
}

interface InjectPageProps {
  apiBaseUrl: string;
}

interface TopologyData {
  containers: string[];
  links: string[][];
  interfaces_by_container: Record<string, string[]>;
}

interface FaultConfig {
  id: string;
  fault_type: string;
  target_node: string;
  target_interface: string;
  target_link: string;
  latency_ms: string | number;
  jitter_ms: string | number;
  correlation_percent: string | number;
  bandwidth_rate_kbit: string | number;
  bandwidth_burst_bytes: string | number;
  bandwidth_latency_ms: string | number;
}

const DEFAULT_FAULT_CONFIG: Omit<FaultConfig, 'id'> = {
    fault_type: 'link_down',
    target_node: '',
    target_interface: '',
    target_link: '',
    latency_ms: 100,
    jitter_ms: '',
    correlation_percent: '',
    bandwidth_rate_kbit: 1000,
    bandwidth_burst_bytes: '',
    bandwidth_latency_ms: '50ms',
};

// --- 追加: sessionStorageのキー ---
const TOPOLOGY_SESSION_KEY = 'topologyData';
// --- 追加終わり ---


const InjectPage: React.FC<InjectPageProps> = ({ apiBaseUrl }) => {
  // --- 変更: ステートの初期値を sessionStorage から取得する関数 ---
  const getInitialState = <T,>(key: string, defaultValue: T): T => {
    try {
      const storedValue = sessionStorage.getItem(key);
      if (storedValue) {
        return JSON.parse(storedValue) as T;
      }
    } catch (error) {
      console.error(`Error reading sessionStorage key “${key}”:`, error);
    }
    return defaultValue;
  };
  // --- 変更終わり ---

  const [containers, setContainers] = useState<string[]>(() => getInitialState<string[]>(`${TOPOLOGY_SESSION_KEY}_containers`, []));
  const [links, setLinks] = useState<string[][]>(() => getInitialState<string[][]>(`${TOPOLOGY_SESSION_KEY}_links`, []));
  const [interfacesByContainer, setInterfacesByContainer] = useState<Record<string, string[]>>(() => getInitialState<Record<string, string[]>>(`${TOPOLOGY_SESSION_KEY}_interfaces`, {}));
  
  const [isLoadingTopology, setIsLoadingTopology] = useState(false);
  const [isInjecting, setIsInjecting] = useState(false);
  const [message, setMessage] = useState<MessageState>({ text: '', type: '' });
  const [detailedResults, setDetailedResults] = useState<DetailedMessage[]>([]);

  const [faultConfigs, setFaultConfigs] = useState<FaultConfig[]>(() => {
    const storedConfigs = getInitialState<FaultConfig[] | null>(`${TOPOLOGY_SESSION_KEY}_faultConfigs`, null);
    // faultConfigs は sessionStorage に保存しないか、または保存する場合はより複雑な初期化が必要
    // ここでは、トポロジ情報に基づいて初期化されるため、sessionStorageからは読み込まない
    return [{ ...DEFAULT_FAULT_CONFIG, id: uuidv4() }];
  });

  // --- 追加: トポロジ情報をステートにセットし、sessionStorageにも保存する関数 ---
  const setAndStoreTopologyData = (data: TopologyData | null) => {
    if (data) {
      const { containers: fetchedContainers, links: fetchedSimpleLinks, interfaces_by_container: fetchedInterfaces } = data;
      setContainers(fetchedContainers);
      setLinks(fetchedSimpleLinks);
      setInterfacesByContainer(fetchedInterfaces);

      sessionStorage.setItem(`${TOPOLOGY_SESSION_KEY}_containers`, JSON.stringify(fetchedContainers));
      sessionStorage.setItem(`${TOPOLOGY_SESSION_KEY}_links`, JSON.stringify(fetchedSimpleLinks));
      sessionStorage.setItem(`${TOPOLOGY_SESSION_KEY}_interfaces`, JSON.stringify(fetchedInterfaces));

      // faultConfigs のデフォルト値を更新
      const updateOrDefaultNode = (currentNode: string) => currentNode || (fetchedContainers.length > 0 ? fetchedContainers[0] : '');
      const updateOrDefaultLink = (currentLink: string) => currentLink || (fetchedSimpleLinks.length > 0 ? `${fetchedSimpleLinks[0][0]}|${fetchedSimpleLinks[0][1]}` : '');
      
      setFaultConfigs(prevConfigs => prevConfigs.map(fc => {
        const newTargetNode = updateOrDefaultNode(fc.target_node);
        const newNodeInterfaces = fetchedInterfaces[newTargetNode] || [];
        let newTargetInterface = fc.target_interface;
        if (newNodeInterfaces.length > 0 && (!newTargetInterface || !newNodeInterfaces.includes(newTargetInterface))) {
            newTargetInterface = newNodeInterfaces[0];
        } else if (newNodeInterfaces.length === 0) {
            newTargetInterface = '';
        }
        return {
          ...fc,
          target_node: newTargetNode,
          target_link: updateOrDefaultLink(fc.target_link),
          target_interface: newTargetInterface,
        };
      }));


    } else { // データがnull（エラーなど）の場合、クリア
      setContainers([]);
      setLinks([]);
      setInterfacesByContainer({});
      sessionStorage.removeItem(`${TOPOLOGY_SESSION_KEY}_containers`);
      sessionStorage.removeItem(`${TOPOLOGY_SESSION_KEY}_links`);
      sessionStorage.removeItem(`${TOPOLOGY_SESSION_KEY}_interfaces`);
    }
  };


  const fetchTopology = useCallback(async () => {
    setIsLoadingTopology(true);
    setMessage({ text: '', type: '' });
    try {
      const response = await axios.get<TopologyData>(`${apiBaseUrl}/insert/topology`);
      setAndStoreTopologyData(response.data); // --- setAndStoreTopologyData を使用 ---
      setMessage({ text: 'トポロジ情報を更新しました。', type: 'success' });
    } catch (error) {
      console.error("Error fetching topology:", error);
      setMessage({ text: 'トポロジ情報の取得に失敗しました。', type: 'error' });
      setAndStoreTopologyData(null); // エラー時はクリア
    } finally {
      setIsLoadingTopology(false);
    }
  }, [apiBaseUrl]); // setAndStoreTopologyData は依存配列に不要

  // --- 初回マウント時にsessionStorageにデータがなければ何もしない ---
  // ボタンが押されたときにfetchTopologyが呼ばれる
  useEffect(() => {
    // 初回ロード時に faultConfigs の target_node などが sessionStorage の containers に基づいて設定されるように
    // faultConfigs の初期化ロジックを調整するか、ここで再設定する
    if (containers.length > 0 || links.length > 0) {
        const updateOrDefaultNode = (currentNode: string) => currentNode || (containers.length > 0 ? containers[0] : '');
        const updateOrDefaultLink = (currentLink: string) => currentLink || (links.length > 0 ? `${links[0][0]}|${links[0][1]}` : '');
      
        setFaultConfigs(prevConfigs => prevConfigs.map(fc => {
          const newTargetNode = updateOrDefaultNode(fc.target_node || (containers.length > 0 ? containers[0] : '')); // fc.target_nodeが空の場合も考慮
          const newNodeInterfaces = interfacesByContainer[newTargetNode] || [];
          let newTargetInterface = fc.target_interface;
          if (newNodeInterfaces.length > 0 && (!newTargetInterface || !newNodeInterfaces.includes(newTargetInterface))) {
              newTargetInterface = newNodeInterfaces[0];
          } else if (newNodeInterfaces.length === 0) {
              newTargetInterface = '';
          }
          return {
            ...fc,
            target_node: newTargetNode,
            target_link: updateOrDefaultLink(fc.target_link || (links.length > 0 ? `${links[0][0]}|${links[0][1]}`: '')),
            target_interface: newTargetInterface,
          };
        }));
    }
  }, [containers, links, interfacesByContainer]); // トポロジデータが変わったらfaultConfigsを調整

  const handleAddFaultConfig = () => {
    const firstContainer = containers.length > 0 ? containers[0] : '';
    const firstLink = links.length > 0 ? `${links[0][0]}|${links[0][1]}` : '';
    const firstNodeInterfaces = interfacesByContainer[firstContainer] || [];
    const firstInterface = firstNodeInterfaces.length > 0 ? firstNodeInterfaces[0] : '';

    setFaultConfigs(prevConfigs => [
      ...prevConfigs,
      { ...DEFAULT_FAULT_CONFIG,
        id: uuidv4(),
        target_node: firstContainer,
        target_link: firstLink,
        target_interface: firstInterface,
      }
    ]);
  };

  const handleRemoveFaultConfig = (idToRemove: string) => {
    setFaultConfigs(prevConfigs => prevConfigs.filter(fc => fc.id !== idToRemove));
  };

  const handleFaultConfigChange = (id: string, field: keyof Omit<FaultConfig, 'id'>, value: any) => {
    setFaultConfigs(prevConfigs =>
      prevConfigs.map(fc =>
        fc.id === id ? { ...fc, [field]: value } : fc
      )
    );
  };

  const handleSubmitAllFaults = async () => {
    if (faultConfigs.length === 0) {
        setMessage({text: "生成する障害が設定されていません。", type: "warning"});
        return;
    }
    setIsInjecting(true);
    setMessage({ text: '', type: '' });
    setDetailedResults([]);

    const payloadsToSubmit = faultConfigs.map(fc => {
      const singlePayload: any = {
        fault_type: fc.fault_type,
        target_node: fc.target_node,
        target_interface: fc.target_interface,
      };
      if (fc.fault_type.includes('link_')) {
        singlePayload.target_link = fc.target_link;
      } else if (fc.fault_type === 'add_latency') {
        singlePayload.latency_ms = Number(fc.latency_ms);
        if (fc.jitter_ms) singlePayload.jitter_ms = Number(fc.jitter_ms);
        if (fc.correlation_percent) singlePayload.correlation_percent = Number(fc.correlation_percent);
      } else if (fc.fault_type === 'limit_bandwidth') {
        singlePayload.bandwidth_rate_kbit = Number(fc.bandwidth_rate_kbit);
        if (fc.bandwidth_burst_bytes) singlePayload.bandwidth_burst_bytes = String(fc.bandwidth_burst_bytes);
        if (fc.bandwidth_latency_ms) singlePayload.bandwidth_latency_ms = String(fc.bandwidth_latency_ms);
      }
      return singlePayload;
    });

    try {
      const response = await axios.post<{ message: string, status: MessageState['type'], details: DetailedMessage[], detailed_messages_for_display?: string }>(
        `${apiBaseUrl}/insert/fault`, payloadsToSubmit
      );
      setMessage({ text: response.data.message, type: response.data.status || 'info' });
      setDetailedResults(response.data.details || []);
      if (response.data.detailed_messages_for_display) {
        console.log("Detailed results from server:\n", response.data.detailed_messages_for_display);
      }
    } catch (error: any) {
      console.error("Error injecting faults:", error);
      setMessage({ text: 'Failed to inject faults. ' + (error.response?.data?.message || error.message) , type: 'error' });
    } finally {
      setIsInjecting(false);
    }
  };

  // トポロジデータがまだロードされていない場合（sessionStorageにもなく、ボタンも押されていない）
  const noTopologyDataLoaded = containers.length === 0 && links.length === 0 && !isLoadingTopology;

  interface FaultConfigBlockProps {
    config: FaultConfig;
    onConfigChange: (id: string, field: keyof Omit<FaultConfig, 'id'>, value: any) => void;
    onRemoveConfig: (id: string) => void;
    allContainers: string[];
    allLinks: string[][];
    interfacesByNode: Record<string, string[]>;
    isFormDisabled: boolean;
  }

  const FaultConfigBlock: React.FC<FaultConfigBlockProps> = ({
    config, onConfigChange, onRemoveConfig, allContainers, allLinks, interfacesByNode, isFormDisabled
  }) => {
    const [nodeInterfaces, setNodeInterfaces] = useState<string[]>([]);

    useEffect(() => {
        const interfaces = interfacesByNode[config.target_node] || [];
        setNodeInterfaces(interfaces);
        // ターゲットノードが変わり、かつ現在のインターフェースが新しいリストにない場合、
        // またはインターフェースが未選択で新しいリストにIFがある場合、インターフェースを更新
        if (interfaces.length > 0 && (!config.target_interface || !interfaces.includes(config.target_interface))) {
            onConfigChange(config.id, 'target_interface', interfaces[0]);
        } else if (interfaces.length === 0 && config.target_interface !== '') {
            onConfigChange(config.id, 'target_interface', '');
        }
    }, [config.target_node, interfacesByNode, config.id, onConfigChange, config.target_interface]);


    const showLinkTargetFields = config.fault_type === 'link_down' || config.fault_type === 'link_up';
    const showNodeSelectorForTcOrNodeOp = !showLinkTargetFields || config.fault_type === 'link_down' || config.fault_type === 'link_up';
    const showInterfaceSelector = config.fault_type === 'add_latency' || config.fault_type === 'limit_bandwidth' || config.fault_type === 'tc_clear' || showLinkTargetFields;
    const showLatencyParams = config.fault_type === 'add_latency';
    const showBandwidthParams = config.fault_type === 'limit_bandwidth';

    return (
        <div style={{ border: '1px dashed #ccc', padding: '15px', marginBottom: '15px', borderRadius: '5px' }}>
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                <h4>障害設定 #{config.id.substring(0, 6)}...</h4>
                <button type="button" onClick={() => onRemoveConfig(config.id)} disabled={isFormDisabled} style={{backgroundColor: '#ff4d4f', color: 'white', border: 'none', padding: '5px 10px', borderRadius: '3px', cursor: 'pointer'}}>削除</button>
            </div>
            <div>
                <label htmlFor={`fault_type-${config.id}`}>障害パターン:</label>
                <select id={`fault_type-${config.id}`} name="fault_type" value={config.fault_type} 
                        onChange={e => onConfigChange(config.id, 'fault_type', e.target.value)}
                        disabled={isFormDisabled}>
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

            {showNodeSelectorForTcOrNodeOp && (
                <div>
                    <label htmlFor={`target_node-${config.id}`}>ターゲットノード:</label>
                    <select id={`target_node-${config.id}`} value={config.target_node}
                            onChange={e => onConfigChange(config.id, 'target_node', e.target.value)}
                            disabled={isFormDisabled || allContainers.length === 0}>
                        {allContainers.length === 0 && <option value="">コンテナなし</option>}
                        {allContainers.map(c => <option key={`${config.id}-node-${c}`} value={c}>{c}</option>)}
                    </select>
                </div>
            )}

            {showInterfaceSelector && (
                <div>
                    <label htmlFor={`target_interface-${config.id}`}>ターゲットインターフェース:</label>
                    <select id={`target_interface-${config.id}`} value={config.target_interface}
                            onChange={e => onConfigChange(config.id, 'target_interface', e.target.value)}
                            disabled={isFormDisabled || nodeInterfaces.length === 0}>
                        {nodeInterfaces.length === 0 && <option value="">-- IFなし --</option>}
                        {nodeInterfaces.map(ifName => <option key={`${config.id}-if-${ifName}`} value={ifName}>{ifName}</option>)}
                    </select>
                </div>
            )}

            {showLinkTargetFields && (
                <div>
                    <label htmlFor={`target_link-${config.id}`}>ターゲットリンク:</label>
                    <select id={`target_link-${config.id}`} value={config.target_link}
                            onChange={e => onConfigChange(config.id, 'target_link', e.target.value)}
                            disabled={isFormDisabled || allLinks.length === 0}>
                        {allLinks.length === 0 && <option value="">リンクなし</option>}
                        {allLinks.map(l => <option key={`${config.id}-link-${l[0]}|${l[1]}`} value={`${l[0]}|${l[1]}`}>{`${l[0]}<-->${l[1]}`}</option>)}
                    </select>
                </div>
            )}

            {showLatencyParams && (
                <>
                    <div><label htmlFor={`latency_ms-${config.id}`}>遅延 (ms):</label><input type="number" id={`latency_ms-${config.id}`} value={config.latency_ms} onChange={e => onConfigChange(config.id, 'latency_ms', e.target.value === '' ? '' : Number(e.target.value))} min="1" required disabled={isFormDisabled} /></div>
                    <div><label htmlFor={`jitter_ms-${config.id}`}>ジッター (ms, 任意):</label><input type="number" id={`jitter_ms-${config.id}`} value={config.jitter_ms} onChange={e => onConfigChange(config.id, 'jitter_ms', e.target.value === '' ? '' : Number(e.target.value))} min="0" disabled={isFormDisabled} /></div>
                    <div><label htmlFor={`correlation_percent-${config.id}`}>相関 (%, 任意):</label><input type="number" id={`correlation_percent-${config.id}`} value={config.correlation_percent} onChange={e => onConfigChange(config.id, 'correlation_percent', e.target.value === '' ? '' : Number(e.target.value))} min="0" max="100" disabled={isFormDisabled} /></div>
                </>
            )}
            {showBandwidthParams && (
                 <>
                    <div>
                      <label htmlFor={`bandwidth_rate_kbit-${config.id}`}>レート (kbit/s):</label><input type="number" id={`bandwidth_rate_kbit-${config.id}`} value={config.bandwidth_rate_kbit} onChange={e => onConfigChange(config.id, 'bandwidth_rate_kbit', e.target.value === '' ? '' : Number(e.target.value))} min="1" required disabled={isFormDisabled} /></div>
                    <div>
                      <label htmlFor={`bandwidth_burst_bytes-${config.id}`}>バースト (bytes, 任意):</label><input type="text" id={`bandwidth_burst_bytes-${config.id}`} value={config.bandwidth_burst_bytes} onChange={e => onConfigChange(config.id, 'bandwidth_burst_bytes', e.target.value)} placeholder="e.g., 32000 or 32kb" disabled={isFormDisabled} />
                      <label>(短期間のトラフィック急増の最大許容値)</label>
                    </div>
                    <div>
                      <label htmlFor={`bandwidth_latency_ms-${config.id}`}>TBFレイテンシ (ms, 任意):</label><input type="text" id={`bandwidth_latency_ms-${config.id}`} value={config.bandwidth_latency_ms} onChange={e => onConfigChange(config.id, 'bandwidth_latency_ms', e.target.value)} placeholder="e.g., 50ms" disabled={isFormDisabled} />
                      <label>(指定した時間内に送信できないトラフィックはドロップ)</label>
                    </div>
                </>
            )}
        </div>
    );
  };

  return (
    <div>
      <h1>障害生成画面</h1>
      {message.text && (
        <div className={`message ${message.type || 'info'}`}>
          {message.text}
        </div>
      )}
      {detailedResults.length > 0 && (
        <div className="detailed-results-section" style={{marginTop: '15px', padding: '10px', border: '1px solid #eee', backgroundColor: '#f9f9f9'}}>
            <h3>生成結果詳細:</h3>
            {detailedResults.map((res, index) => (
                <div key={index} className={`message ${res.status || 'info'}`} style={{marginBottom: '5px'}}>
                    <strong>{res.fault_type} ({res.target_display || 'N/A'}):</strong> {res.status.toUpperCase()} - {res.message}
                </div>
            ))}
        </div>
      )}

      <div style={{ marginBottom: '20px', paddingBottom: '10px', borderBottom: '1px solid #eee' }}>
        <button onClick={fetchTopology} disabled={isLoadingTopology || isInjecting}>
          {isLoadingTopology ? 'トポロジ情報 更新中...' : 'トポロジ情報を更新'}
        </button>
        {noTopologyDataLoaded && <p style={{color: 'orange', marginLeft: '10px', display: 'inline'}}>トポロジ情報が未取得です。ボタンを押して取得してください。</p>}
      </div>

      <h2>検出したトポロジ</h2>
      <div style={{display: 'flex'}}>
        <div style={{marginRight: '100px'}}>
          <h3>コンテナ一覧:</h3>
          {containers.length > 0 ? (
            containers.map(container => <div className="container" key={container}>{container}</div>)
          ) : (
            <p>コンテナが検出されていません。上記ボタンでトポロジ情報を取得してください。</p>
          )}
        </div>
        <div>
          <h3>仮想リンク一覧 (推定):</h3>
          {links.length > 0 ? (
            links.map(link => <div className="link" key={`${link[0]}-${link[1]}`}>{`${link[0]} <--> ${link[1]}`}</div>)
          ) : (
            <p>コンテナ間のリンクが検出されません。</p>
          )}
        </div>
      </div>

      <div className="form-section">
        <h2>障害生成リスト</h2>
        {faultConfigs.map((fc) => (
          <FaultConfigBlock
            key={fc.id}
            config={fc}
            onConfigChange={handleFaultConfigChange}
            onRemoveConfig={handleRemoveFaultConfig}
            allContainers={containers}
            allLinks={links}
            interfacesByNode={interfacesByContainer}
            isFormDisabled={isInjecting}
          />
        ))}
        <button type="button" onClick={handleAddFaultConfig} disabled={isInjecting || noTopologyDataLoaded} style={{marginTop: '10px', marginRight: '10px'}}>障害設定を追加</button>
        <button type="button" onClick={handleSubmitAllFaults} disabled={isInjecting || faultConfigs.length === 0 || noTopologyDataLoaded} style={{marginTop: '10px', backgroundColor: '#28a745'}}>
          {isInjecting ? '生成中...' : `選択した ${faultConfigs.length} 個の障害を生成実行`}
        </button>
      </div>
    </div>
  );
}

export default InjectPage;