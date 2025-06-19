import React, { useState, useEffect, useCallback, memo } from 'react';
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
  loop_node1: string;
  loop_node2: string;
  loop_dummy_dest_ip: string;
  loop_duration_sec: string | number;
  loop_ping_target_ip?: string; 
  loop_ping_count?: string | number; 
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
    loop_node1: '',
    loop_node2: '',
    loop_dummy_dest_ip: '192.168.7.2/32',
    loop_duration_sec: 10,
    loop_ping_target_ip: '192.168.7.2/32', 
    loop_ping_count: 5,      
};

const TOPOLOGY_SESSION_KEY_PREFIX = 'injectPage_topology_';

interface FaultConfigBlockProps {
    initialConfig: FaultConfig; 
    onConfigChange: (id: string, field: keyof Omit<FaultConfig, 'id'>, value: any) => void; 
    onRemoveConfig: (id: string) => void;
    allContainers: string[];
    allLinks: string[][];
    interfacesByNode: Record<string, string[]>;
    isFormDisabled: boolean;
}

const FaultConfigBlock: React.FC<FaultConfigBlockProps> = memo(({
    initialConfig, onConfigChange, onRemoveConfig, allContainers, allLinks, interfacesByNode, isFormDisabled
}) => {
    const [localConfig, setLocalConfig] = useState<FaultConfig>(initialConfig);
    const [nodeInterfaces, setNodeInterfaces] = useState<string[]>([]);

    useEffect(() => {
        setLocalConfig(initialConfig); 
    }, [initialConfig]);

    useEffect(() => {
        const interfaces = interfacesByNode[localConfig.target_node] || [];
        setNodeInterfaces(interfaces);
    }, [localConfig.target_node, interfacesByNode]);

    const handleLocalChange = (field: keyof Omit<FaultConfig, 'id'>, value: any) => {
        const newConfigPart = { [field]: value };
        let newTargetInterface = localConfig.target_interface;

        if (field === 'target_node') {
            const newNodeInterfaces = interfacesByNode[value as string] || [];
            newTargetInterface = newNodeInterfaces.length > 0 ? newNodeInterfaces[0] : '';
            setLocalConfig(prev => ({ ...prev, ...newConfigPart, target_interface: newTargetInterface }));
            onConfigChange(localConfig.id, field, value);
            onConfigChange(localConfig.id, 'target_interface', newTargetInterface); 
        } else {
            setLocalConfig(prev => ({ ...prev, ...newConfigPart }));
            onConfigChange(localConfig.id, field, value);
        }
    };

    const showLinkTargetFields = localConfig.fault_type === 'link_down' || localConfig.fault_type === 'link_up';
    const showNodeSelector = 
        localConfig.fault_type.includes('node_') ||
        localConfig.fault_type.startsWith('tc_') || 
        localConfig.fault_type === 'add_latency' || 
        localConfig.fault_type === 'limit_bandwidth' ||
        localConfig.fault_type === 'routing_loop_timed' || 
        showLinkTargetFields;

    const showInterfaceSelector = localConfig.fault_type === 'add_latency' || localConfig.fault_type === 'limit_bandwidth' || localConfig.fault_type === 'tc_clear' || showLinkTargetFields;
    const showLatencyParams = localConfig.fault_type === 'add_latency';
    const showBandwidthParams = localConfig.fault_type === 'limit_bandwidth';
    const showRoutingLoopTimedParams = localConfig.fault_type === 'routing_loop_timed';

    return (
        <div style={{ border: '1px dashed #ccc', padding: '15px', marginBottom: '15px', borderRadius: '5px' }}>
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                <h4>障害設定 #{localConfig.id.substring(0, 6)}...</h4>
                <button type="button" onClick={() => onRemoveConfig(localConfig.id)} disabled={isFormDisabled} style={{backgroundColor: '#ff4d4f', color: 'white', border: 'none', padding: '5px 10px', borderRadius: '3px', cursor: 'pointer'}}>削除</button>
            </div>
            <div>
                <label htmlFor={`fault_type-${localConfig.id}`}>障害パターン:</label>
                <select id={`fault_type-${localConfig.id}`} name="fault_type" value={localConfig.fault_type} 
                        onChange={e => handleLocalChange('fault_type', e.target.value)}
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
                    <option value="routing_loop_timed">Timed Routing Loop (L3)</option>
                </select>
            </div>

            {showNodeSelector && (localConfig.fault_type !== 'routing_loop_timed') && 
                <div>
                    <label htmlFor={`target_node-${localConfig.id}`}>ターゲットノード:</label>
                    <select id={`target_node-${localConfig.id}`} value={localConfig.target_node}
                            onChange={e => handleLocalChange('target_node', e.target.value)}
                            disabled={isFormDisabled || allContainers.length === 0}>
                        {allContainers.length === 0 && <option value="">コンテナなし</option>}
                        {allContainers.map(c => <option key={`${localConfig.id}-node-${c}`} value={c}>{c}</option>)}
                    </select>
                </div>
            }
            {showInterfaceSelector && (
                <div>
                    <label htmlFor={`target_interface-${localConfig.id}`}>ターゲットインターフェース:</label>
                    <select id={`target_interface-${localConfig.id}`} value={localConfig.target_interface}
                            onChange={e => handleLocalChange('target_interface', e.target.value)}
                            disabled={isFormDisabled || nodeInterfaces.length === 0}>
                        {nodeInterfaces.length === 0 && <option value="">-- IFなし --</option>}
                        {nodeInterfaces.map(ifName => <option key={`${localConfig.id}-if-${ifName}`} value={ifName}>{ifName}</option>)}
                    </select>
                </div>
            )}
            {showLinkTargetFields && (
                <div>
                    <label htmlFor={`target_link-${localConfig.id}`}>ターゲットリンク:</label>
                    <select id={`target_link-${localConfig.id}`} value={localConfig.target_link}
                            onChange={e => handleLocalChange('target_link', e.target.value)}
                            disabled={isFormDisabled || allLinks.length === 0}>
                        {allLinks.length === 0 && <option value="">リンクなし</option>}
                        {allLinks.map(l => <option key={`${localConfig.id}-link-${l[0]}|${l[1]}`} value={`${l[0]}|${l[1]}`}>{`${l[0]}<-->${l[1]}`}</option>)}
                    </select>
                </div>
            )}

            {showLatencyParams && (
                <>
                    <div><label htmlFor={`latency_ms-${localConfig.id}`}>遅延 (ms):</label><input type="number" id={`latency_ms-${localConfig.id}`} value={localConfig.latency_ms} onChange={e => handleLocalChange('latency_ms', e.target.value === '' ? '' : Number(e.target.value))} min="1" required disabled={isFormDisabled} /></div>
                    <div><label htmlFor={`jitter_ms-${localConfig.id}`}>ジッター (ms, 任意):</label><input type="number" id={`jitter_ms-${localConfig.id}`} value={localConfig.jitter_ms} onChange={e => handleLocalChange('jitter_ms', e.target.value === '' ? '' : Number(e.target.value))} min="0" disabled={isFormDisabled} /></div>
                    <div><label htmlFor={`correlation_percent-${localConfig.id}`}>相関 (%, 任意):</label><input type="number" id={`correlation_percent-${localConfig.id}`} value={localConfig.correlation_percent} onChange={e => handleLocalChange('correlation_percent', e.target.value === '' ? '' : Number(e.target.value))} min="0" max="100" disabled={isFormDisabled} /></div>
                </>
            )}
            {showBandwidthParams && (
                 <>
                    <div><label htmlFor={`bandwidth_rate_kbit-${localConfig.id}`}>レート (kbit/s):</label><input type="number" id={`bandwidth_rate_kbit-${localConfig.id}`} value={localConfig.bandwidth_rate_kbit} onChange={e => handleLocalChange('bandwidth_rate_kbit', e.target.value === '' ? '' : Number(e.target.value))} min="1" required disabled={isFormDisabled} /></div>
                    <div><label htmlFor={`bandwidth_burst_bytes-${localConfig.id}`}>バースト (bytes, 任意):</label><p>(短期間のトラフィック急増の最大許容値)</p><input type="text" id={`bandwidth_burst_bytes-${localConfig.id}`} value={localConfig.bandwidth_burst_bytes} onChange={e => handleLocalChange('bandwidth_burst_bytes', e.target.value)} placeholder="e.g., 32000 or 32kb" disabled={isFormDisabled} /></div>
                    <div><label htmlFor={`bandwidth_latency_ms-${localConfig.id}`}>TBFレイテンシ (ms, 任意):</label><p>(指定した時間内に送信できないトラフィックはドロップ)</p><input type="text" id={`bandwidth_latency_ms-${localConfig.id}`} value={localConfig.bandwidth_latency_ms} onChange={e => handleLocalChange('bandwidth_latency_ms', e.target.value)} placeholder="e.g., 50ms" disabled={isFormDisabled} /></div>
                </>
            )}
            {showRoutingLoopTimedParams && (
                <>
                    <div><label htmlFor={`loop_node1-${localConfig.id}`}>ループノード1:</label><select id={`loop_node1-${localConfig.id}`} value={localConfig.loop_node1} onChange={e => handleLocalChange('loop_node1', e.target.value)} disabled={isFormDisabled || allContainers.length === 0}>{allContainers.length === 0 && <option value="">コンテナなし</option>}{allContainers.map(c => <option key={`${localConfig.id}-ln1-${c}`} value={c}>{c}</option>)}</select></div>
                    <div><label htmlFor={`loop_node2-${localConfig.id}`}>ループノード2:</label><select id={`loop_node2-${localConfig.id}`} value={localConfig.loop_node2} onChange={e => handleLocalChange('loop_node2', e.target.value)} disabled={isFormDisabled || allContainers.length === 0}>{allContainers.length === 0 && <option value="">コンテナなし</option>}{allContainers.map(c => <option key={`${localConfig.id}-ln2-${c}`} value={c}>{c}</option>)}</select></div>
                    <div><label htmlFor={`loop_dummy_dest_ip-${localConfig.id}`}>ダミー宛先IP (CIDR):</label><input type="text" id={`loop_dummy_dest_ip-${localConfig.id}`} value={localConfig.loop_dummy_dest_ip} onChange={e => handleLocalChange('loop_dummy_dest_ip', e.target.value)} placeholder="e.g., 10.255.255.255/32" disabled={isFormDisabled} /></div>
                    <div><label htmlFor={`loop_duration_sec-${localConfig.id}`}>ループ持続時間 (秒):</label><input type="number" id={`loop_duration_sec-${localConfig.id}`} value={localConfig.loop_duration_sec} onChange={e => handleLocalChange('loop_duration_sec', e.target.value === '' ? '' : Number(e.target.value))} min="1" required disabled={isFormDisabled} /></div>
                    <hr style={{margin: "10px 0"}} />
                    <p style={{fontSize: "0.9em", color: "#333", fontWeight: "bold"}}>ループ中Ping観測 (任意):</p>
                    <div>
                        <label htmlFor={`loop_ping_target_ip-${localConfig.id}`}>Ping宛先IP:</label>
                        <input type="text" id={`loop_ping_target_ip-${localConfig.id}`} value={localConfig.loop_ping_target_ip || ''}
                               onChange={e => handleLocalChange('loop_ping_target_ip', e.target.value)}
                               placeholder="e.g., 8.8.8.8 or another node" disabled={isFormDisabled} />
                    </div>
                    <div>
                        <label htmlFor={`loop_ping_count-${localConfig.id}`}>Ping回数:</label>
                        <input type="number" id={`loop_ping_count-${localConfig.id}`} value={localConfig.loop_ping_count || ''}
                               onChange={e => handleLocalChange('loop_ping_count', e.target.value === '' ? '' : Number(e.target.value))}
                               min="1" disabled={isFormDisabled} />
                    </div>
                    <p style={{fontSize: "0.8em", color: "#666", marginLeft: "155px"}}>指定した2ノード間でダミー宛先へのルートを相互に向け、時間制限付きでループを発生させます。解除は自動で行われます。</p>
                </>
            )}
        </div>
    );
});

const InjectPage: React.FC<InjectPageProps> = ({ apiBaseUrl }) => {
  const getInitialState = <T,>(keySuffix: string, defaultValue: T): T => {
    try {
      const storedValue = sessionStorage.getItem(`${TOPOLOGY_SESSION_KEY_PREFIX}${keySuffix}`);
      if (storedValue) { return JSON.parse(storedValue) as T; }
    } catch (error) { console.error(`Error reading sessionStorage key “${TOPOLOGY_SESSION_KEY_PREFIX}${keySuffix}”:`, error); }
    return defaultValue;
  };

  const [containers, setContainers] = useState<string[]>(() => getInitialState<string[]>('containers', []));
  const [links, setLinks] = useState<string[][]>(() => getInitialState<string[][]>('links', []));
  const [interfacesByContainer, setInterfacesByContainer] = useState<Record<string, string[]>>(() => getInitialState<Record<string, string[]>>('interfacesByContainer', {}));
  
  const [isLoadingTopology, setIsLoadingTopology] = useState(false);
  const [isInjecting, setIsInjecting] = useState(false);
  const [message, setMessage] = useState<MessageState>({ text: '', type: '' });
  const [detailedResults, setDetailedResults] = useState<DetailedMessage[]>([]);
  const [faultConfigs, setFaultConfigs] = useState<FaultConfig[]>([{ ...DEFAULT_FAULT_CONFIG, id: uuidv4() }]);

  const setAndStoreTopologyData = useCallback((data: TopologyData | null) => {
    if (data) {
      const { containers: fetchedContainers, links: fetchedSimpleLinks, interfaces_by_container: fetchedInterfaces } = data;
      setContainers(fetchedContainers);
      setLinks(fetchedSimpleLinks);
      setInterfacesByContainer(fetchedInterfaces);

      sessionStorage.setItem(`${TOPOLOGY_SESSION_KEY_PREFIX}containers`, JSON.stringify(fetchedContainers));
      sessionStorage.setItem(`${TOPOLOGY_SESSION_KEY_PREFIX}links`, JSON.stringify(fetchedSimpleLinks));
      sessionStorage.setItem(`${TOPOLOGY_SESSION_KEY_PREFIX}interfacesByContainer`, JSON.stringify(fetchedInterfaces));

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
          loop_node1: fc.loop_node1 || (fetchedContainers.length > 0 ? fetchedContainers[0] : ''),
          loop_node2: fc.loop_node2 || (fetchedContainers.length > 1 ? fetchedContainers[1] : (fetchedContainers.length > 0 ? fetchedContainers[0] : '')),
        };
      }));
    } else { 
      setContainers([]); setLinks([]); setInterfacesByContainer({});
      sessionStorage.removeItem(`${TOPOLOGY_SESSION_KEY_PREFIX}containers`);
      sessionStorage.removeItem(`${TOPOLOGY_SESSION_KEY_PREFIX}links`);
      sessionStorage.removeItem(`${TOPOLOGY_SESSION_KEY_PREFIX}interfacesByContainer`);
    }
  }, []);

  const fetchTopology = useCallback(async () => {
    setIsLoadingTopology(true); setMessage({ text: '', type: '' });
    try {
      const response = await axios.get<TopologyData>(`${apiBaseUrl}/insert/topology`);
      setAndStoreTopologyData(response.data); 
      setMessage({ text: 'トポロジ情報を更新しました。', type: 'success' });
    } catch (error) {
      console.error("Error fetching topology:", error);
      setMessage({ text: 'トポロジ情報の取得に失敗しました。', type: 'error' });
      setAndStoreTopologyData(null);
    } finally { setIsLoadingTopology(false); }
  }, [apiBaseUrl, setAndStoreTopologyData]);

  useEffect(() => {
    if (containers.length > 0 || Object.keys(interfacesByContainer).length > 0 || links.length > 0) {
        const updateOrDefaultNode = (currentNode: string) => currentNode || (containers.length > 0 ? containers[0] : '');
        const updateOrDefaultLink = (currentLink: string) => currentLink || (links.length > 0 ? `${links[0][0]}|${links[0][1]}`: '');
      
        setFaultConfigs(prevConfigs => {
            if (prevConfigs.length === 1 && prevConfigs[0].target_node === '' && prevConfigs[0].target_link === '' && prevConfigs[0].target_interface === '') {
                const newTargetNode = updateOrDefaultNode('');
                const newNodeInterfaces = interfacesByContainer[newTargetNode] || [];
                const newTargetInterface = newNodeInterfaces.length > 0 ? newNodeInterfaces[0] : '';
                return [{
                    ...DEFAULT_FAULT_CONFIG,
                    id: prevConfigs[0].id,
                    target_node: newTargetNode,
                    target_link: updateOrDefaultLink(''),
                    target_interface: newTargetInterface,
                    loop_node1: newTargetNode, 
                    loop_node2: containers.length > 1 ? containers[1] : (containers.length > 0 ? containers[0] : ''),
                }];
            }
            return prevConfigs.map(fc => {
                const newTargetNode = updateOrDefaultNode(fc.target_node);
                const newNodeInterfaces = interfacesByContainer[newTargetNode] || [];
                let newTargetInterface = fc.target_interface;
                 if (newNodeInterfaces.length > 0 && (!newTargetInterface || !newNodeInterfaces.includes(newTargetInterface))) {
                    newTargetInterface = newNodeInterfaces[0];
                } else if (newNodeInterfaces.length === 0 && newTargetInterface !== '') {
                    newTargetInterface = '';
                }
                return {
                    ...fc,
                    target_node: newTargetNode,
                    target_link: updateOrDefaultLink(fc.target_link),
                    target_interface: newTargetInterface,
                    loop_node1: fc.loop_node1 || newTargetNode,
                    loop_node2: fc.loop_node2 || (containers.length > 1 ? containers[1] : (containers.length > 0 ? containers[0] : '')),
                };
            });
        });
    }
  }, [containers, links, interfacesByContainer]);

  const handleAddFaultConfig = () => {
    const firstContainer = containers.length > 0 ? containers[0] : '';
    const secondContainer = containers.length > 1 ? containers[1] : (containers.length > 0 ? containers[0] : '');
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
        loop_node1: firstContainer,
        loop_node2: secondContainer,
      }
    ]);
  };

  const handleRemoveFaultConfig = (idToRemove: string) => {
    setFaultConfigs(prevConfigs => {
        const newConfigs = prevConfigs.filter(fc => fc.id !== idToRemove);
        if (newConfigs.length === 0) {
            const firstContainer = containers.length > 0 ? containers[0] : '';
            const secondContainer = containers.length > 1 ? containers[1] : (containers.length > 0 ? containers[0] : '');
            const firstLink = links.length > 0 ? `${links[0][0]}|${links[0][1]}` : '';
            const firstNodeInterfaces = interfacesByContainer[firstContainer] || [];
            const firstInterface = firstNodeInterfaces.length > 0 ? firstNodeInterfaces[0] : '';
            return [{ ...DEFAULT_FAULT_CONFIG, id: uuidv4(), target_node: firstContainer, target_link: firstLink, target_interface: firstInterface, loop_node1: firstContainer, loop_node2: secondContainer }];
        }
        return newConfigs;
    });
  };

  const handleFaultConfigChange = useCallback((id: string, field: keyof Omit<FaultConfig, 'id'>, value: any) => {
    setFaultConfigs(prevConfigs =>
      prevConfigs.map(fc => {
        if (fc.id === id) {
          const updatedFc = { ...fc, [field]: value };
          if (field === 'target_node' && fc.fault_type !== 'routing_loop_timed') { 
            const newNodeInterfaces = interfacesByContainer[value as string] || [];
            updatedFc.target_interface = newNodeInterfaces.length > 0 ? newNodeInterfaces[0] : '';
          }
          return updatedFc;
        }
        return fc;
      })
    );
  }, [interfacesByContainer]);

  const handleSubmitAllFaults = async () => {
    if (faultConfigs.length === 0) {
        setMessage({text: "生成する障害が設定されていません。", type: "warning"});
        return;
    }
    setIsInjecting(true); setMessage({ text: '', type: '' }); setDetailedResults([]);
    const payloadsToSubmit = faultConfigs.map(fc => {
      const singlePayload: any = { fault_type: fc.fault_type };
      if (fc.target_node) singlePayload.target_node = fc.target_node;
      if (fc.target_interface) singlePayload.target_interface = fc.target_interface;

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
      } else if (fc.fault_type === 'routing_loop_timed') {
        singlePayload.loop_node1 = fc.loop_node1;
        singlePayload.loop_node2 = fc.loop_node2;
        singlePayload.loop_dummy_dest_ip = fc.loop_dummy_dest_ip;
        singlePayload.loop_duration_sec = Number(fc.loop_duration_sec);
        if (fc.loop_ping_target_ip) singlePayload.loop_ping_target_ip = fc.loop_ping_target_ip;
        if (fc.loop_ping_count) singlePayload.loop_ping_count = Number(fc.loop_ping_count);
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
    } finally { setIsInjecting(false); }
  };

  const noTopologyDataLoaded = containers.length === 0 && Object.keys(interfacesByContainer).length === 0 && !isLoadingTopology;

  return (
    <div>
      <h1>障害生成画面</h1>
      {message.text && ( <div className={`message ${message.type || 'info'}`}>{message.text}</div> )}
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
      <div style={{display: 'flex', flexWrap: 'wrap'}}>
        <div style={{marginRight: '30px', marginBottom: '20px'}}>
          <h3>コンテナ一覧:</h3>
          {containers.length > 0 ? (
            containers.map(container => <div className="container" key={container} style={{padding:'2px 0'}}>{container}</div>)
          ) : (
            <p>コンテナが検出されていません。上記ボタンでトポロジ情報を取得してください。</p>
          )}
        </div>
        <div>
          <h3>仮想リンク一覧 (推定):</h3>
          {links.length > 0 ? (
            links.map(link => <div className="link" key={`${link[0]}-${link[1]}`} style={{padding:'2px 0'}}>{`${link[0]} <--> ${link[1]}`}</div>)
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
            initialConfig={fc}
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