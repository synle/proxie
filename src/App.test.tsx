import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import App from './App';

describe('App', () => {
  it('renders without crashing', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Proxie')).toBeInTheDocument();
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
