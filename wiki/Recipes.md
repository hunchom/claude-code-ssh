# Recipes

Real workflows. Each recipe is a Claude conversation — what you ask, what Claude does, and the outcome.

## Debug a 502 on production

```
you:    prod01 is returning 502s on /api/*. find and fix.
Claude: [ssh_journalctl unit=nginx since=15min] upstream connect timeout to 10.0.0.31:8080
        [ssh_service_status server=app01 service=payments-api] inactive (dead)
        [ssh_systemctl server=app01 service=payments-api action=start] ok
        [ssh_service_status server=app01 service=payments-api] active (running)
        [ssh_execute server=prod01 command="curl -s -o /dev/null -w '%{http_code}' http://10.0.0.31:8080/health"] 200
        root cause: payments-api died ~8 min ago, nginx still timing out on cached upstream
        fix: restarted payments-api, nginx now healthy
you:    add a hook so nagios pages me next time this fires
Claude: [ssh_hooks add server=app01 event=on_service_down
         action="curl -X POST https://nagios.internal/incidents -d 'unit=payments-api'"] registered
```

## Rolling config deploy across a fleet

```
you:    roll out nginx.conf to every web server, one at a time,
        pause if any fail the healthcheck
Claude: [ssh_group_manage list group=web] 4 servers: web01, web02, web03, web04
        [ssh_deploy server=web01 local=./nginx.conf remote=/etc/nginx/nginx.conf
         healthcheck="curl -fs http://localhost/health" on_fail=rollback] ok
        web01: deployed, healthcheck 200, rollback on failure armed
        [ssh_deploy server=web02 ...] ok
        [ssh_deploy server=web03 ...] FAILED healthcheck
        paused. web03 reverted. web01, web02 still on new config.
        proceed? rollback all?
you:    rollback all
Claude: [ssh_deploy web01 rollback] [ssh_deploy web02 rollback] done
```

## Backup + restore across hosts

```
you:    back up the payments db from prod01, download it, restore it to staging01
Claude: [ssh_backup_create server=prod01 type=postgresql database=payments] ok
        dump: /var/backups/ssh-manager/payments-20260414-154322.sql.gz (342 MB)
        [ssh_download server=prod01 remote=/var/backups/.../payments-*.sql.gz local=./]
        downloaded 342 MB
        [ssh_backup_restore server=staging01 type=postgresql database=payments
         source=./payments-20260414-154322.sql.gz] ok
        restored. staging01 payments now matches prod01 as of 15:43:22 UTC.
```

## Long-running log investigation with a persistent tail

```
you:    tail the payments-api log on prod01, filter for 5xx
Claude: [ssh_tail_start server=prod01 file=/var/log/payments-api/error.log grep="[5][0-9]{2}"] session=t-7a4e
        watching. i'll report lines as they arrive.
you:    [5 minutes later] anything?
Claude: [ssh_tail_read session=t-7a4e] 23 matches. mostly 502s from /api/webhook/stripe.
        pattern: every 30s, on :15 and :45. cron job hitting a broken endpoint?
you:    check cron
Claude: [ssh_execute server=prod01 command="crontab -l -u payments"] 
        */30 * * * * curl -X POST http://localhost/api/webhook/stripe-retry
        confirmed. the retry job exists but the endpoint was removed in v4.2.
        fix: remove the crontab line on prod01.
```

## Open a tunnel to internal Grafana through a bastion

```
you:    open a tunnel to grafana.internal:3000 through bastion, local port 3000
Claude: [ssh_tunnel_create type=local server=bastion
         local_port=3000 remote_host=grafana.internal remote_port=3000] ok
        tunnel open: localhost:3000 -> grafana.internal:3000 via bastion
        browse to http://localhost:3000
you:    [later] close it
Claude: [ssh_tunnel_list] 1 active: grafana (id=tun-3)
        [ssh_tunnel_close id=tun-3] closed
```

## Find and restart a memory-hungry process

```
you:    redis on prod03 is using too much memory. figure out what's happening and restart it if needed.
Claude: [ssh_execute server=prod03 command="redis-cli info memory | head -20"]
        used_memory_human: 9.4G
        maxmemory_human: 8G
        mem_fragmentation_ratio: 1.42
        over the ceiling, fragmentation is bad too.
        [ssh_process_manager server=prod03 filter="redis-server"] pid=1247 rss=9.8G
        [ssh_systemctl server=prod03 service=redis action=restart] ok
        [ssh_execute server=prod03 command="redis-cli info memory | head -5"]
        used_memory_human: 14.2M
        fresh start, back under the ceiling.
        recommend investigating what filled the keyspace — want me to dump the top keys by size?
```

## Multi-server port reachability check

```
you:    can all web servers reach the payments-db on 5432?
Claude: [ssh_port_test servers=[web01,web02,web03,web04]
         probes=[{host=payments-db, port=5432}]]
        web01 -> payments-db:5432  OK (3ms)
        web02 -> payments-db:5432  OK (4ms)
        web03 -> payments-db:5432  TIMEOUT (5000ms)
        web04 -> payments-db:5432  OK (3ms)
        web03 can't reach. probably a firewall rule.
        [ssh_execute server=web03 command="sudo iptables -L OUTPUT -n | grep 5432"] (empty)
        no explicit block. try the security group if this is AWS.
```

## Diff a local config against prod

```
you:    has anything changed in /etc/nginx/nginx.conf on prod01 vs my local ./nginx.conf?
Claude: [ssh_diff server=prod01 remote=/etc/nginx/nginx.conf local=./nginx.conf]
        @@ line 42
        - worker_connections 1024;
        + worker_connections 2048;
        @@ line 78
        - keepalive_timeout 65;
        + keepalive_timeout 30;
        2 differences. prod has higher worker count and shorter keepalive.
        someone (not you) tuned this on the box. want me to pull prod's version into local?
```

## Query the DB safely

```
you:    how many payments are in the last hour
Claude: [ssh_db_query server=prod01 database=payments
         sql="SELECT count(*) FROM payments WHERE created_at > now() - interval '1 hour'"]
        count: 3,412
you:    drop the table
Claude: i can't. ssh_db_query rejects non-SELECT statements (security policy).
        if you really want to drop it, use ssh_execute with psql — but i'd need you to
        confirm: 'yes drop the payments table on prod01'.
you:    no, that was a test.
Claude: good test.
```

## Plan a complex change before executing

```
you:    i want to migrate payments-db from prod01 to a new host prod05. plan it.
Claude: [ssh_plan goal="migrate payments-db from prod01 to prod05"]
        proposed plan:
        1. ssh_backup_create prod01 -> dump payments (est. 400 MB)
        2. ssh_execute prod05 -> install postgres 16, create payments role
        3. ssh_upload dump -> prod05:/tmp
        4. ssh_backup_restore prod05 <- dump
        5. ssh_execute prod05 -> verify row counts match prod01
        6. ssh_execute web01..web04 -> update DATABASE_URL env var
        7. ssh_systemctl web* action=restart -> reload app workers
        8. ssh_tail_start web01 /var/log/app.log grep=ERROR -> watch for 10 min
        rollback if step 5 mismatches or step 8 shows sustained errors.
        total est. time: 12 minutes, 8 tool calls.
        confirm to proceed?
you:    confirm, but pause before step 6 so i can double-check
Claude: acknowledged. executing 1-5, then waiting for your ok on 6.
```
