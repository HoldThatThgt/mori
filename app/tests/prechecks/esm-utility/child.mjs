// 预检子进程：ESM 入口，静态 import pi，回报版本与 Node 版本。
import { VERSION, getAgentDir } from '@earendil-works/pi-coding-agent';

process.parentPort.postMessage({ esm: true, node: process.versions.node, pi: VERSION ?? 'unknown', agentDir: getAgentDir() });
