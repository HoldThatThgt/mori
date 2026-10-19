// 页面的 CSP 不允许 eval；zod 在定义 schema 时会试探 eval（控制台随之报一条 CSP 错误）。
// 这个模块必须最先载入，让 zod 在任何 schema 定义之前就不再试探。

import { z } from 'zod';

z.config({ jitless: true });
