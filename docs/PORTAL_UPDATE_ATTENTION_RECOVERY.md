# Portal update attention recovery

`updated_with_errors` and `recovery_required` deliberately block another
Dashboard update. Clearing that block is a root operator action, not a browser
retry switch. Repair and verify the host first; the acknowledgement only
removes the current-operation pointer and preserves the historical receipt.

## Preconditions

1. Confirm the fixed updater unit is no longer running:

   ```bash
   systemctl show bridgesllm-portal-self-update.service \
     -p LoadState -p ActiveState -p SubState -p Job --no-pager
   ```

2. Do not delete transaction journals to make the check pass. Both paths must
   be genuinely absent after successful installer recovery:

   ```bash
   test ! -e /var/lib/bridgesllm-installer/active-update.json \
     -a ! -L /var/lib/bridgesllm-installer/active-update.json \
     -a ! -e /var/lib/bridgesllm-installer/cutover-update.json \
     -a ! -L /var/lib/bridgesllm-installer/cutover-update.json
   ```

3. Repair the reported host failure and verify Portal health. For
   `updated_with_errors`, the installed version must be the receipt's target.
   For `recovery_required`, it must be either the receipt's previous or target
   version. The helper independently attests all four installed version sources
   and rejects symlinks, hardlinks, ownership drift, inconsistent versions, or
   a surviving journal.

4. Record the exact current operation ID:

   ```bash
   operation_id="$(python3 /var/lib/bridgesllm-installer/dashboard-update-progress.py current-operation)"
   printf '%s\n' "$operation_id"
   ```

## Resolve the admission block

Run the protected helper with the exact acknowledgement phrase:

```bash
python3 /var/lib/bridgesllm-installer/dashboard-update-progress.py \
  resolve-attention \
  --operation-id "$operation_id" \
  --acknowledgement 'I HAVE REPAIRED AND VERIFIED THIS PORTAL UPDATE'
```

The command is fail-closed. It removes only the atomically attested `current`
pointer; `<operation-id>.json` and its bounded log remain as evidence.

## Verify resolution

`current-operation` must now report no current operation (exit status 3), while
the historical receipt remains readable by its operation ID:

```bash
python3 /var/lib/bridgesllm-installer/dashboard-update-progress.py current-operation
test "$?" -eq 3
test -f "/var/lib/bridgesllm-installer/dashboard-updates/${operation_id}.json"
```

Reload the owner Dashboard. The preserved receipt should identify itself as
historical and report that its admission block is cleared. Only then review a
new signed update attempt.
