# AKIRA Local Companion

The Companion process runs locally on your laptop and gives AKIRA (the concierge running on the Mini) hands to drive a persistent browser on your behalf.

## How it works

1. **Outbound transport:** The Companion dials outbound to the Mini's Mission Control SSE command channel. This means no inbound ports need to be opened on your laptop.
2. **Persistent profile:** Chromium is launched with a persistent user profile (defaults to `~/.akira-companion/profile`). Interactive login sessions are saved locally, meaning passwords never leave your machine or get stored/typed by AKIRA.
3. **Hard gate security:** Click events on dangerous keywords (e.g. `buy`, `delete`, `pay`, `checkout`) or sensitive domains (e.g. banking) are hard-gated by the local Companion process and require manual confirmation from you in the Mission Control HUD before they run.

## Setup and Installation

1. Navigate to the `companion/` directory:
   ```bash
   cd companion
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

3. Install the Playwright browser:
   ```bash
   pnpm exec playwright install chromium
   ```

4. Create a `.env` file inside the `companion/` directory containing your keys:
   ```env
   # The URL of your Mission Control instance
   MINI_URL=http://localhost:3000
   
   # Shared secret matching the COMPANION_TOKEN set in the Mini's .env
   COMPANION_TOKEN=your_secure_preshared_token
   
   # Comma-separated domains requiring hard-gate confirmation for any click
   COMPANION_SENSITIVE=mybank.com,paypal.com
   ```

## Running the Companion

Start the local agent:
```bash
pnpm start
```

You will see log output indicating that the Companion has connected to the Mini.
The HUD top bar will now show "laptop ●" indicating that the browser tools are active.
