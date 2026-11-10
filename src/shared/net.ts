import dns from 'node:dns';
import net from 'node:net';

// Process-wide network defaults. This WSL setup has no IPv6 route, and Neon's IPv4 addresses take
// ~270 ms to connect from here, longer than Node's default 250 ms per-address attempt. Prefer IPv4
// and allow 2 s per address so Postgres (and PayPal) connections don't fail spuriously.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);
