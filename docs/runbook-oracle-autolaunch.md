# Oracle A1 auto-launch — beating the "out of host capacity" wall

Oracle's Always-Free ARM (A1) capacity is heavily oversubscribed, so the console
often returns **"Out of host capacity."** This runbook configures the OCI CLI once,
then runs `deploy/oci-autolaunch.sh`, which retries the launch across all your
availability domains until one frees up — hands-off.

Run all of this **on your local machine** (Git Bash). You only need to launch the
instance this way; the rest of the deploy is the normal `docs/runbook-deploy-oracle.md`.

## 1. Install the OCI CLI
**Windows (PowerShell, as your user):**
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.ps1 -OutFile install.ps1; .\install.ps1 -AcceptAllDefaults"
```
Then reopen Git Bash and confirm:
```bash
oci --version
```
(Alternative if you have Python: `pip install oci-cli`.)

## 2. Configure auth (one-time API key)
```bash
oci setup config
```
Answer the prompts:
- **Location for config** → accept default (`~/.oci/config`).
- **User OCID** → Console → top-right profile → **My profile** → copy the **OCID**.
- **Tenancy OCID** → Console → profile → **Tenancy: …** → copy its **OCID**.
- **Region** → your home region (e.g. `us-ashburn-1`).
- **Generate a new API Signing key?** → **Y** (accept the default key path/passphrase-empty).

It writes a key pair under `~/.oci/`. Now **upload the public key** so the API trusts it:
- Console → profile → **My profile → Tokens and keys / API keys → Add API key → Paste public key**.
- Paste the contents of `~/.oci/oci_api_key_public.pem` (the CLI prints its path; `cat` it).

Verify auth works:
```bash
oci iam region list >/dev/null && echo "OCI CLI authenticated OK"
```

## 3. Make sure a VCN + public subnet exists
Failed console launches do **not** create networking, so you likely need one:
- Console → **Networking → Virtual Cloud Networks → Create VCN → "Create VCN with Internet Connectivity"** (the wizard). Accept defaults. This makes a VCN with a **public subnet**, internet gateway, and route — exactly what we need.

## 4. Find the two OCIDs the script needs
```bash
# Compartment: on free tier the ROOT tenancy compartment is fine — use your tenancy OCID.
export COMPARTMENT_OCID="ocid1.tenancy.oc1..xxxx"   # same tenancy OCID from step 2

# Subnet: list subnets in that compartment and copy the PUBLIC one's id.
oci network subnet list --compartment-id "$COMPARTMENT_OCID" \
  --query 'data[].{name:"display-name", id:id, public:"prohibit-public-ip-on-vnic"}' --output table
export SUBNET_OCID="ocid1.subnet.oc1.<region>.xxxx"   # the one with public=false (public IPs allowed)
```
(`prohibit-public-ip-on-vnic = false` means it's a public subnet.)

## 5. Run the auto-launcher
```bash
cd /c/Users/A'KeemDrew/AXOD/axod-mission-control
# COMPARTMENT_OCID and SUBNET_OCID are already exported from step 4.
# SSH key defaults to ~/.ssh/id_ed25519.pub (already created).
bash deploy/oci-autolaunch.sh
```
It auto-discovers your availability domains + the Ubuntu 24.04 arm64 image, then loops:
```
[14:02:11] attempt 1 — trying AD-1 ...
   …no capacity in AD-1.
[14:02:19] attempt 2 — trying AD-2 ...
   …no capacity in AD-2.
   cycled all ADs; sleeping 60s...
...
SUCCESS — instance is RUNNING in AD-2.
  instance OCID: ocid1.instance.oc1...
  public IP:     203.0.113.45
```
Leave it running (a terminal tab is fine). When it prints **SUCCESS + public IP**, you're
done here — continue at `docs/runbook-deploy-oracle.md` **§1 (reserve the IP)**.

### Tuning (optional env vars before running)
```bash
export OCPUS=1 MEM_GB=6        # smaller = grabbed more easily; resize to 2/12 later
export RETRY_SECONDS=90        # gentler polling
export MAX_ATTEMPTS=200        # give up after N tries instead of forever
```

## Troubleshooting
- **Stops with "config/auth error, not capacity":** the script hit a non-capacity failure
  (bad OCID, key not uploaded yet, no subnet). The exact OCI error is printed above the message
  — fix that and re-run. The script intentionally does **not** retry these.
- **"NotAuthenticated" / 401:** the API public key isn't uploaded (step 2) or the wrong
  user/tenancy OCID is in `~/.oci/config`.
- **Auto-discovery finds no image:** pass one explicitly — `oci compute image list
  --compartment-id "$COMPARTMENT_OCID" --operating-system "Canonical Ubuntu"
  --operating-system-version "24.04" --shape VM.Standard.A1.Flex --output table`, then
  `export IMAGE_OCID=...`.
- **Want to stop:** Ctrl-C. Re-running is safe (it just launches when capacity appears; it does
  not clean up — if you accidentally launch two, terminate the extra in the console).
