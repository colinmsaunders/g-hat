import { createRoot } from "react-dom/client";
import "./style.css";
const root = createRoot(document.getElementById("root")!);
import("./App")
  .then(({ default: App }) => root.render(<App />))
  .catch(() =>
    root.render(
      <main style={{ padding: 40 }}>
        <h1>We couldn’t connect.</h1>
        <p>Check that the API is running and reload the page.</p>
        <button onClick={() => location.reload()}>Try again</button>
      </main>,
    ),
  );
