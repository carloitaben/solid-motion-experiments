import { Loading } from 'solid-js';
import { Router } from './router';
import './App.css';

// The app shell. There is no header or nav: the layout lab and the refs lab
// link to each other, and the 404 links back. Page titles come from each
// route's <Title> (src/routes).
export default function App() {
  return (
    <Router>
      {(props) => (
        <Loading fallback={<main>Loading…</main>}>{props.children}</Loading>
      )}
    </Router>
  );
}
