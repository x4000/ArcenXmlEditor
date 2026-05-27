import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './components/App';
import DetachedApp from './components/DetachedApp';

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode');
const windowId = params.get('windowId');

const root = createRoot(document.getElementById('root'));
if (mode === 'detached') {
  root.render(<DetachedApp windowId={windowId} />);
} else {
  root.render(<App />);
}
