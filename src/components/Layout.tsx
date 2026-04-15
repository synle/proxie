import { ReactNode, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Box,
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  AppBar,
  Typography,
  IconButton,
  Chip,
} from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import FilterListIcon from '@mui/icons-material/FilterList';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import { invoke } from '@tauri-apps/api/core';

const DRAWER_WIDTH = 220;

const navItems = [
  { label: 'Connections', path: '/connections', icon: <SwapHorizIcon /> },
  { label: 'Host Rules', path: '/hosts', icon: <FilterListIcon /> },
  { label: 'Setup', path: '/setup', icon: <SettingsIcon /> },
];

export default function Layout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [proxyRunning, setProxyRunning] = useState(false);

  const toggleProxy = async () => {
    try {
      if (proxyRunning) {
        await invoke('stop_proxy');
        setProxyRunning(false);
      } else {
        await invoke('start_proxy');
        setProxyRunning(true);
      }
    } catch (e) {
      console.error('Proxy toggle failed:', e);
    }
  };

  return (
    <Box sx={{ display: 'flex', height: '100vh' }}>
      <AppBar position='fixed' sx={{ zIndex: (theme) => theme.zIndex.drawer + 1 }}>
        <Toolbar variant='dense'>
          <Typography variant='h6' noWrap sx={{ flexGrow: 1 }}>
            Proxie
          </Typography>
          <Chip
            label={proxyRunning ? 'Running' : 'Stopped'}
            color={proxyRunning ? 'success' : 'default'}
            size='small'
            sx={{ mr: 1 }}
          />
          <IconButton color='inherit' onClick={toggleProxy} size='small'>
            {proxyRunning ? <StopIcon /> : <PlayArrowIcon />}
          </IconButton>
        </Toolbar>
      </AppBar>
      <Drawer
        variant='permanent'
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' },
        }}>
        <Toolbar variant='dense' />
        <List>
          {navItems.map((item) => (
            <ListItemButton
              key={item.path}
              selected={location.pathname === item.path}
              onClick={() => navigate(item.path)}>
              <ListItemIcon>{item.icon}</ListItemIcon>
              <ListItemText primary={item.label} />
            </ListItemButton>
          ))}
        </List>
      </Drawer>
      <Box component='main' sx={{ flexGrow: 1, p: 2, mt: 6, overflow: 'auto' }}>
        {children}
      </Box>
    </Box>
  );
}
