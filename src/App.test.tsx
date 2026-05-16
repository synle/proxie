import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import App from './App';

describe('App', () => {
  it('renders without crashing', async () => {
    render(<App />);
    // The AppBar title is the versioned build stamp (e.g.
    // "Proxie DEV v0.0.0-test 2026-01-01") — match the channel-agnostic
    // "Proxie" prefix so the assertion survives channel/version changes.
    await waitFor(() => {
      expect(screen.getByText(/^Proxie\b/)).toBeInTheDocument();
    });
  });

  it('renders navigation items', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText('Connections').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Host Rules')).toBeInTheDocument();
      expect(screen.getByText('Setup')).toBeInTheDocument();
    });
  });

  it('shows proxy status chip', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Stopped')).toBeInTheDocument();
    });
  });
});
