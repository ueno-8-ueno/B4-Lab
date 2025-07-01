import { BrowserRouter as Router, Route, Routes, Link } from 'react-router-dom';
import MeasurePage from './components/MeasurePages';
import InjectPage from './components/InjectPages';
import AnalysisPage from './components/AnalysisPages';
import './App.css';

const API_BASE_URL = 'http://localhost:5000/api'; // Flask APIのベースURL

function App() {
  return (
    <Router>
      <div className="app-container">
        <nav>
          <ul>
            <li><Link to="/">Measure</Link></li>
            <li><Link to="/inject">Inject Fault</Link></li>
            <li><Link to="/analysis">Analysis</Link></li>
          </ul>
        </nav>
        <div className="page-container">
          <Routes>
            <Route path="/" element={<MeasurePage apiBaseUrl={API_BASE_URL} />} />
            <Route path="/inject" element={<InjectPage apiBaseUrl={API_BASE_URL} />} /> 
            <Route path="/analysis" element={<AnalysisPage apiBaseUrl={API_BASE_URL} />} /> 
          </Routes>
        </div>
      </div>
    </Router>
  );
}

export default App;
