#!/usr/bin/env python3
"""Auto-retry launcher for the Oracle Always-Free A1 instance, using the OCI
Python SDK directly (no oci-cli — its bundled help files blow Windows' 260-char
path limit on machines without admin/long-path support).

Loops over the tenancy's availability domains, retrying launch_instance until
Oracle grants A1 capacity (the classic "Out of host capacity" wall), then prints
the new instance's public IP. Capacity errors are retried; any other error
(auth, quota, bad OCID) stops immediately so a misconfig can't spin forever.

Config comes from ~/.oci/config [DEFAULT] plus these env vars:
  COMPARTMENT_OCID  default: tenancy from config
  SUBNET_OCID       required
  SSH_PUB_PATH      default: ~/.ssh/id_ed25519.pub
  DISPLAY_NAME      default: mc-bridge
  OCPUS / MEM_GB    default: 2 / 12   (Always-Free A1 ceiling is 4 / 24)
  RETRY_SECONDS     default: 60       wait between full AD cycles
  MAX_ATTEMPTS      default: 0        0 = retry forever
  IMAGE_OCID        optional; auto-discovered (Ubuntu 24.04 arm64) if unset
  ADS               optional; space-separated AD names, else auto-discovered
  CHECK             if set to 1: validate auth + discovery, then exit (no launch)
"""
import os
import sys
import time

import oci

SHAPE = "VM.Standard.A1.Flex"


def env(name, default=None, required=False):
    val = os.environ.get(name, default)
    if required and not val:
        sys.exit(f"ERROR: {name} is required but not set.")
    return val


def alert(title, text):
    """Best-effort attention grab on Windows (sound + modal popup). No-ops elsewhere."""
    try:
        import winsound
        for _ in range(3):
            winsound.Beep(880, 250)
    except Exception:
        pass
    try:
        import ctypes  # MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST
        ctypes.windll.user32.MessageBoxW(0, text, title, 0x40 | 0x10000 | 0x40000)
    except Exception:
        pass


def main():
    config = oci.config.from_file()  # ~/.oci/config [DEFAULT]
    compartment = env("COMPARTMENT_OCID", config.get("tenancy"))
    subnet = env("SUBNET_OCID", required=True)
    ssh_pub_path = os.path.expanduser(env("SSH_PUB_PATH", "~/.ssh/id_ed25519.pub"))
    display_name = env("DISPLAY_NAME", "mc-bridge")
    ocpus = float(env("OCPUS", "2"))
    mem_gb = float(env("MEM_GB", "12"))
    retry_seconds = int(env("RETRY_SECONDS", "60"))
    per_attempt_seconds = int(env("PER_ATTEMPT_SECONDS", "30"))
    ratelimit_backoff = int(env("RATELIMIT_BACKOFF", "180"))
    max_attempts = int(env("MAX_ATTEMPTS", "0"))
    image_id = env("IMAGE_OCID", "")
    ads_env = env("ADS", "")
    check_only = env("CHECK", "") == "1"

    if not os.path.isfile(ssh_pub_path):
        sys.exit(f"ERROR: SSH public key not found at {ssh_pub_path}")
    with open(ssh_pub_path) as fh:
        ssh_pub = fh.read().strip()

    identity = oci.identity.IdentityClient(config)
    compute = oci.core.ComputeClient(config)
    network = oci.core.VirtualNetworkClient(config)

    # ---- discovery (also proves auth works) --------------------------------
    if ads_env:
        ads = ads_env.split()
    else:
        print("Discovering availability domains...")
        ads = [ad.name for ad in identity.list_availability_domains(compartment).data]
    if not ads:
        sys.exit("ERROR: no availability domains found.")
    print("Availability domains:", ", ".join(ads))

    if not image_id:
        print("Finding latest Ubuntu 24.04 (arm64) image...")
        images = compute.list_images(
            compartment,
            operating_system="Canonical Ubuntu",
            operating_system_version="24.04",
            shape=SHAPE,
            sort_by="TIMECREATED",
            sort_order="DESC",
        ).data
        if not images:
            sys.exit("ERROR: no Ubuntu 24.04 arm64 image found for this shape.")
        image_id = images[0].id
    print("Image:", image_id)

    if check_only:
        print("CHECK OK — auth + discovery succeeded. (No launch attempted.)")
        return

    # ---- launch retry loop -------------------------------------------------
    print(f"Launching {SHAPE} ({ocpus:g} OCPU / {mem_gb:g}GB) named '{display_name}'.")
    print("Retrying across ADs until capacity appears. Ctrl-C to stop.")
    # --- Phase 1: create the instance (retry across ADs until capacity) -----
    # Only `launch_instance` lives in this retry loop. Once it returns an
    # instance id we leave immediately, so a later network blip can never
    # trigger a SECOND launch (duplicate instance).
    attempt = 0
    instance_id = None
    won_ad = None
    while instance_id is None:
        for ad in ads:
            attempt += 1
            stamp = time.strftime("%H:%M:%S")
            print(f"[{stamp}] attempt {attempt} — trying {ad} ...", flush=True)
            details = oci.core.models.LaunchInstanceDetails(
                availability_domain=ad,
                compartment_id=compartment,
                shape=SHAPE,
                shape_config=oci.core.models.LaunchInstanceShapeConfigDetails(
                    ocpus=ocpus, memory_in_gbs=mem_gb
                ),
                source_details=oci.core.models.InstanceSourceViaImageDetails(image_id=image_id),
                create_vnic_details=oci.core.models.CreateVnicDetails(
                    subnet_id=subnet, assign_public_ip=True
                ),
                display_name=display_name,
                metadata={"ssh_authorized_keys": ssh_pub},
            )
            try:
                instance_id = compute.launch_instance(details).data.id
                won_ad = ad
                print(f"   launched ({instance_id}).", flush=True)
                break
            except oci.exceptions.ServiceError as exc:
                code = (exc.code or "")
                blob = f"{exc.status} {code} {exc.message}".lower()
                is_capacity = (
                    "capacity" in blob
                    or (exc.status == 500 and code.lower() == "internalerror")
                )
                is_ratelimited = exc.status == 429 or code.lower() == "toomanyrequests"
                if is_capacity:
                    print(f"   …no capacity in {ad}.", flush=True)
                elif is_ratelimited:
                    # Transient: OCI throttled us. Back off, then keep going.
                    print(f"   rate-limited (429); backing off {ratelimit_backoff}s...", flush=True)
                    time.sleep(ratelimit_backoff)
                else:
                    print(f"   launch failed (NON-capacity): "
                          f"{exc.status} {code} — {exc.message}", file=sys.stderr)
                    alert("Oracle A1 launcher stopped",
                          f"Non-capacity error — needs attention:\n{exc.status} {code} — {exc.message}")
                    sys.exit("Stopping — this is a config/auth/quota error, not capacity.")
            except oci.exceptions.RequestException as exc:
                # Transient network blip (e.g. RemoteDisconnected) — not a real
                # failure; just retry the next attempt.
                print(f"   transient network error; retrying... ({exc})", file=sys.stderr)
            if max_attempts and attempt >= max_attempts:
                sys.exit(f"Hit MAX_ATTEMPTS={max_attempts} without capacity.")
            # Space out attempts so we don't trip OCI's per-user request limit.
            time.sleep(per_attempt_seconds)
        if instance_id is None:
            print(f"   cycled all ADs; sleeping {retry_seconds}s...", flush=True)
            time.sleep(retry_seconds)

    # --- Phase 2: wait for RUNNING + fetch public IP (no re-launch on error) -
    print(f"   waiting for RUNNING in {won_ad}...", flush=True)
    for _ in range(6):
        try:
            oci.wait_until(
                compute, compute.get_instance(instance_id),
                "lifecycle_state", "RUNNING", max_wait_seconds=900,
            )
            break
        except oci.exceptions.RequestException as exc:
            print(f"   network blip while waiting; retrying... ({exc})", file=sys.stderr)
            time.sleep(15)

    public_ip = None
    try:
        for att in compute.list_vnic_attachments(compartment, instance_id=instance_id).data:
            vnic = network.get_vnic(att.vnic_id).data
            if vnic.public_ip:
                public_ip = vnic.public_ip
                break
    except oci.exceptions.RequestException:
        pass

    print("")
    print(f"SUCCESS — instance launched in {won_ad}.")
    print(f"  instance OCID: {instance_id}")
    print(f"  public IP:     {public_ip or '<not fetched — see console>'}")
    alert("Oracle A1 launched!",
          f"mc-bridge launched in {won_ad}.\nPublic IP: {public_ip or '<see console>'}")


if __name__ == "__main__":
    main()
