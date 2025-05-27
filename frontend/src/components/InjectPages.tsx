import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

function InjectPage({ apiBaseUrl }) {
  const [containers, setContainers] = useState([]);
  const [links, setLinks] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState({ text: '', type: '' });

  const [faultType, setFaultType] = useState('link_down');
  const [targetNode, setTargetNode] = useState('');
  const [targetLink, setTargetLink] = useState('');
  const [targetInterfaceLink, setTargetInterfaceLink] = useState('eth1');
  // const [cpuDuration, setCpuDuration] = useState('60');
  // const [bwRate, setBwRate] = useState('1mbit');
  // const [targetInterfaceBw, setTargetInterfaceBw] = useState('');

  const fetchTopology = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await axios.get(`${apiBaseUrl}/insert/topology`);
      setContainers(response.data.containers || []);
      setLinks(response.data.links || []);
      if (response.data.containers && response.data.containers.length > 0) {
        setTargetNode(response.data.containers[0]);
      }
      if (response.data.links && response.data.links.length > 0) {
        setTargetLink(`${response.data.links[0][0]}|${response.data.links[0][1]}`);
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

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsLoading(true);
    setMessage({ text: '', type: '' });

    const payload = {
      fault_type: faultType,
      target_node: faultType.includes('node_') ? targetNode : undefined,
      target_link: faultType.includes('link_') ? targetLink : undefined,
      target_interface: faultType.includes('link_') ? targetInterfaceLink : undefined,
      // cpu_duration: faultType === 'cpu_stress' ? cpuDuration : undefined,
      // bw_rate: faultType === 'bw_limit' ? bwRate : undefined,
      // target_interface_bw: faultType === 'bw_limit' ? targetInterfaceBw : undefined,
    };

    try {
      const response = await axios.post(`${apiBaseUrl}/insert/fault`, payload);
      setMessage({ text: response.data.message, type: response.data.status });
    } catch (error) {
      console.error("Error injecting fault:", error);
      setMessage({ text: 'Failed to inject fault. ' + (error.response?.data?.message || error.message) , type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading && containers.length === 0 && links.length === 0) { // Show loading only on initial fetch
    return <p>Loading topology data...</p>;
  }

  return (
    <div>
      <h1>Containerlab Chaos Injector</h1>
      {message.text && (
        <div className={`message ${message.type}`}>
          {message.text}
        </div>
      )}

      <h2>Detected Topology</h2>
      <h3>Containers:</h3>
      {containers.length > 0 ? (
        containers.map(container => <div className="container" key={container}>{container}</div>)
      ) : (
        <p>No Containerlab containers detected (or Docker error).</p>
      )}

      <h3>Links (Estimated):</h3>
      <p><i>Note: Interface names for links are not reliably detected. Link Down/Up actions might target incorrect interfaces.</i></p>
      {links.length > 0 ? (
        links.map(link => <div className="link" key={`${link[0]}-${link[1]}`}>{`${link[0]} <--> ${link[1]}`}</div>)
      ) : (
        <p>No links detected between containers.</p>
      )}

      <div className="form-section">
        <h2>Inject Fault</h2>
        <form onSubmit={handleSubmit}>
          <div>
            <label htmlFor="fault_type">Fault Type:</label>
            <select id="fault_type" name="fault_type" value={faultType} onChange={e => setFaultType(e.target.value)}>
              <option value="link_down">Link Down</option>
              <option value="link_up">Link Up</option>
              <option value="node_stop">Node Stop</option>
              <option value="node_start">Node Start</option>
              <option value="node_pause">Node Pause</option>
              <option value="node_unpause">Node Unpause</option>
              {/* <option value="cpu_stress">CPU Stress</option> */}
              {/* <option value="bw_limit">Bandwidth Limit</option> */}
            </select>
          </div>

          {(faultType === 'link_down' || faultType === 'link_up') && (
            <div id="link_target">
              <div>
                <label htmlFor="target_link">Target Link:</label>
                <select id="target_link" name="target_link" value={targetLink} onChange={e => setTargetLink(e.target.value)} disabled={links.length === 0}>
                  {links.map(link => (
                    <option key={`${link[0]}|${link[1]}`} value={`${link[0]}|${link[1]}`}>
                      {`${link[0]} <--> ${link[1]}`}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="target_interface_link">Interface Name (Guess):</label>
                <input type="text" id="target_interface_link" name="target_interface_link" value={targetInterfaceLink} onChange={e => setTargetInterfaceLink(e.target.value)} placeholder="e.g., eth1 (Best Guess)" />
              </div>
            </div>
          )}

          {(faultType.includes('node_') /*|| faultType === 'cpu_stress' || faultType === 'bw_limit'*/) && (
            <div id="node_target">
              <label htmlFor="target_node">Target Node:</label>
              <select id="target_node" name="target_node" value={targetNode} onChange={e => setTargetNode(e.target.value)} disabled={containers.length === 0}>
                {containers.map(container => (
                  <option key={container} value={container}>{container}</option>
                ))}
              </select>
            </div>
          )}

          {/* Parameters for future faults
          {faultType === 'cpu_stress' && (
            <div id="cpu_params">
              <label htmlFor="cpu_duration">Duration (seconds):</label>
              <input type="text" id="cpu_duration" name="cpu_duration" value={cpuDuration} onChange={e => setCpuDuration(e.target.value)} />
            </div>
          )}
          {faultType === 'bw_limit' && (
            <div id="bw_params">
              <div>
                <label htmlFor="bw_rate">Rate (e.g., 1mbit):</label>
                <input type="text" id="bw_rate" name="bw_rate" value={bwRate} onChange={e => setBwRate(e.target.value)} />
              </div>
              <div>
                <label htmlFor="target_interface_bw">Interface Name:</label>
                <input type="text" id="target_interface_bw" name="target_interface_bw" value={targetInterfaceBw} onChange={e => setTargetInterfaceBw(e.target.value)} placeholder="e.g., eth1" />
              </div>
            </div>
          )}
          */}
          <br/>
          <button type="submit" disabled={isLoading}>Inject Fault</button>
        </form>
      </div>
    </div>
  );
}

export default InjectPage;