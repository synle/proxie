import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';
import Layout from './components/Layout';
import SetupPage from './pages/SetupPage';
import HostRulesPage from './pages/HostRulesPage';
import ConnectionsPage from './pages/ConnectionsPage';
import InterceptorPage from './pages/InterceptorPage';

const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#90caf9' },
    secondary: { main: '#f48fb1' },
    background: { default: '#121212', paper: '#1e1e1e' },
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    fontSize: 13,
  },
});

export default function App() {
  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path='/setup' element={<SetupPage />} />
            <Route path='/hosts' element={<HostRulesPage />} />
            <Route path='/connections' element={<ConnectionsPage />} />
            <Route path='/interceptor' element={<InterceptorPage />} />
            <Route path='*' element={<Navigate to='/connections' replace />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </ThemeProvider>
  );
}
