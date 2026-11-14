#!/bin/bash
# Builds a small git repository with tags in several languages, a main branch and a feature branch, for the real-app
# test and the screenshot. Usage: scripts/make-sample.sh <empty target dir>
set -eu
T="$1"; rm -rf "$T"; mkdir -p "$T"; cd "$T"
export GIT_AUTHOR_NAME="Dana Reyes" GIT_AUTHOR_EMAIL=dana@example.com GIT_COMMITTER_NAME="Dana Reyes" GIT_COMMITTER_EMAIL=dana@example.com
export GIT_AUTHOR_DATE=2025-06-03T09:12:00Z GIT_COMMITTER_DATE=2025-06-03T09:12:00Z
git init -q -b main; git config commit.gpgsign false
mkdir -p src/api src/ui scripts docs build
cat > .gitignore <<'X'
build/
*.log
X
cat > src/api/client.ts <<'X'
import { request } from './http';

export interface Order { id: string; total: number; currency: string }

// TODO: cache the order list for 30 seconds
export async function listOrders(page = 1): Promise<Order[]> {
  const res = await request(`/orders?page=${page}`);
  /* FIXME(dana): retry on 503, the gateway drops the first call after deploys */
  return res.json();
}

export function formatTotal(o: Order): string {
  // NOTE: amounts arrive in cents
  return (o.total / 100).toFixed(2) + ' ' + o.currency;
}
X
cat > src/api/http.ts <<'X'
// HACK the staging gateway needs this header until the proxy is fixed
const HEADERS = { 'x-env': 'staging' };

export function request(path: string) {
  // BUG: path is not URL-encoded
  return fetch(path, { headers: HEADERS });
}
X
cat > scripts/deploy.py <<'X'
import subprocess

# TODO(sam): read the region from the config file
REGION = "eu-west-1"

def deploy():
    """Deploy the service.

    XXX this skips the health check
    """
    subprocess.run(["./release.sh", REGION], check=True)
X
cat > docs/notes.md <<'X'
# Release notes

- TODO: write the migration guide
- Shipped the new checkout
X
echo "// TODO ignored build output" > build/bundle.js
git add -A; git commit -q -m "first version"
export GIT_AUTHOR_DATE=2026-10-20T15:40:00Z GIT_COMMITTER_DATE=2026-10-20T15:40:00Z
cat > src/ui/Cart.tsx <<'X'
export function Cart({ items }: { items: { name: string; price: number }[] }) {
  // TODO: empty state
  const total = items.reduce((s, i) => s + i.price, 0);
  return <div className="cart">{items.length} items, {total}</div>;
}
X
git add -A; git commit -q -m "cart"
git checkout -q -b feature/checkout
export GIT_AUTHOR_NAME="Sam Ito" GIT_AUTHOR_EMAIL=sam@example.com GIT_AUTHOR_DATE=2026-11-10T11:00:00Z GIT_COMMITTER_DATE=2026-11-10T11:00:00Z
sed -i.bak 's#// HACK the staging gateway needs this header until the proxy is fixed#// the proxy sends the env header now#' src/api/http.ts && rm src/api/http.ts.bak
cat >> src/ui/Cart.tsx <<'X'

// FIXME: totals ignore discounts
export const DISCOUNT = 0;
X
git commit -q -am "checkout work"
