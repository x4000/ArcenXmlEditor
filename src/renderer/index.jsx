import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './components/App';
import DetachedApp from './components/DetachedApp';
import ErrorBoundary from './components/ErrorBoundary';

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode');
const windowId = params.get('windowId');

const root = createRoot(document.getElementById('root'));
if (mode === 'detached') {
  root.render(
    <ErrorBoundary label="detached window">
      <DetachedApp windowId={windowId} />
    </ErrorBoundary>
  );
} else {
  root.render(
    <ErrorBoundary label="main window">
      <App />
    </ErrorBoundary>
  );
}
