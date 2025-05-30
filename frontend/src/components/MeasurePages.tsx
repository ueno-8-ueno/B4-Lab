import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

function MeasurePage({ apiBaseUrl }) {
  const [isRunning, setIsRunning] = useState(false);
  const [isLoading, setIsLoading] = useState(true); // Initial loading for status
  const [message, setMessage] = useState({ text: '', type: '' });

  const fetchStatus = useCallback(async () => {
    try {
      const response = await axios.get(`${apiBaseUrl}/measure/status`);
      setIsRunning(response.data.is_running);
    } catch (error) {
      console.error("Error fetching status:", error);
      setMessage({ text: 'Failed to fetch measurement status.', type: 'error' });
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleStart = async () => {
    setIsLoading(true);
    setMessage({ text: '', type: '' });
    try {
      const response = await axios.post(`${apiBaseUrl}/measure/start`);
      setMessage({ text: response.data.message, type: response.data.status });
      if (response.data.status === 'success') {
        setIsRunning(true);
      }
    } catch (error) {
      console.error("Error starting measurement:", error);
      setMessage({ text: 'Failed to start measurement.', type: 'error' });
    } finally {
      setIsLoading(false);
      fetchStatus(); // Re-fetch status to be sure
    }
  };

  const handleStop = async () => {
    setIsLoading(true);
    setMessage({ text: '', type: '' });
    try {
      const response = await axios.post(`${apiBaseUrl}/measure/stop`);
      setMessage({ text: response.data.message, type: response.data.status });
      if (response.data.status === 'success' || response.data.status === 'info' || response.data.status === 'warning') {
        setIsRunning(false);
      }
    } catch (error) {
      console.error("Error stopping measurement:", error);
      setMessage({ text: 'Failed to stop measurement.', type: 'error' });
    } finally {
      setIsLoading(false);
      fetchStatus(); // Re-fetch status
    }
  };

  return (
    <div>
      <h1>測定の実行</h1>
      {message.text && (
        <div className={`message ${message.type}`}>
          {message.text}
        </div>
      )}
      <div className="button-group">
        <button onClick={handleStart} disabled={isRunning || isLoading}>
          {isLoading && !isRunning ? '処理中...' : isRunning ? '実行中...' : '実行'}
        </button>
        <button onClick={handleStop} disabled={!isRunning || isLoading} className="stop-button">
          {isLoading && isRunning ? '停止処理中...' : !isRunning ? '停止' : '停止'}
        </button>
      </div>
       {isLoading && <p>測定中...</p>}
    </div>
  );
}

export default MeasurePage;