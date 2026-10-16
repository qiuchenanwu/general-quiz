/**
 * vue-shim.js —— 沙箱里跑文档代码用的**迷你运行时**（一段字符串，不是模块副作用）
 * ============================================================================
 * 为什么需要它：
 *   官方文档的交互示例基本都是 `const count = ref(0)` 这种**片段**，不是能直接执行的
 *   程序：`import { ref } from 'vue'` 在沙箱里没法解析（沙箱没有网络、没有构建器）。
 *   于是这里手写一份**只覆盖文档示例用到的那部分**实现，让那些片段在沙箱里真跑起来。
 *
 * ⚠️ 它**不是 Vue**，是刻意做小的：
 *   - `ref` / `reactive` / `computed` 的取值、`.value` 解包、代理缓存/同一性
 *     （`reactive(raw) === reactive(raw)`、`proxy.nested !== raw`）这几条与文档一致
 *   - 响应式**触发**（watch 回调、组件更新）基本不做：没有调度器就没有重新渲染
 *   - `watch` / `onMounted` / `defineProps` 之类是**哑实现**，只为让片段不报错
 *   所以：沙箱结果只在"文档示例那几条"的范围内可信。界面必须把这句话说清楚。
 *
 * 怎么保证它没跑偏：出题工具（quiz/tools/units_to_tasks.mjs）会**用同一份运行时**
 * 在 Node 里跑一遍文档片段，并把结果和文档里 `// => 1` 这类注释对账 ——
 * **对不上的片段一律不生成"预测输出"题**。也就是说，题库里带期望输出的题，
 * 都是先在编译期被文档自己的注释证明过的。
 *
 * 这段源码会被**原样拼进** <iframe srcdoc> 的 <script> 里（见 core/code.js），
 * 也会被出题工具在 Node 里 eval 一遍 —— 两边必须是同一份，否则浏览器里跑出来的
 * 和题目标注的期望输出就会不一致。
 */

/** 运行时源码。约束：**不能出现 `</`**（否则拼进 srcdoc 会提前结束脚本） */
export const SANDBOX_RUNTIME = String.raw`
/* ── 1. 输出格式化：Node 和浏览器必须打印成一模一样的东西 ────────────── */
function __fmt(v, depth, seen) {
  depth = depth || 0;
  seen = seen || [];
  if (typeof v === 'string') return v;
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (typeof v === 'function') return '[Function: ' + (v.name || 'anonymous') + ']';
  if (typeof v === 'symbol') return v.toString();
  if (v instanceof Error) return v.name + ': ' + v.message;
  if (depth >= 3) return Array.isArray(v) ? '[Array]' : '[Object]';
  if (seen.indexOf(v) >= 0) return '[Circular]';
  seen = seen.concat([v]);
  if (Array.isArray(v)) return '[' + v.map(function (x) { return __fmt(x, depth + 1, seen); }).join(', ') + ']';
  if (v instanceof Map) return 'Map(' + v.size + ')';
  if (v instanceof Set) return 'Set(' + v.size + ')';
  try {
    return '{ ' + Object.keys(v).map(function (k) {
      return k + ': ' + __fmt(v[k], depth + 1, seen);
    }).join(', ') + ' }';
  } catch (e) { return String(v); }
}
function __line(args) {
  var out = [];
  for (var i = 0; i < args.length; i++) out.push(__fmt(args[i], 0, []));
  return out.join(' ');
}
/** 把 console 接到 __send 上；Node 里 __send 往数组里塞，浏览器里 postMessage */
function __captureConsole(__send) {
  console.log = function () { __send('stdout', __line(arguments)); };
  console.info = console.log;
  console.debug = console.log;
  console.warn = function () { __send('warn', __line(arguments)); };
  console.error = function () { __send('stderr', __line(arguments)); };
}

/* ── 2. 迷你 Vue：只做文档示例用到的那点事 ────────────────────────────── */
var __refKey = '__v_isRef';
var __proxyCache = new WeakMap();   // 原始对象 → 它的代理（同一性靠它）
var __rawOf = new WeakMap();        // 代理 → 原始对象
var __isProxy = new WeakSet();

function __wrap(value) {
  // 存进响应式对象的东西会被代理一层（文档：proxy.nested !== raw）
  if (value && typeof value === 'object' && !__isProxy.has(value)) return __reactive(value);
  return value;
}

function __reactive(target) {
  if (target === null || typeof target !== 'object') return target;
  if (__isProxy.has(target)) return target;               // 代理的代理还是自己
  if (__proxyCache.has(target)) return __proxyCache.get(target);
  if (target instanceof Map || target instanceof Set) return __collection(target);

  var proxy = new Proxy(target, {
    get: function (t, key, recv) {
      var v = Reflect.get(t, key, recv);
      // 文档：reactive({ count }) 里 state.count 拿到的是 ref 的值（自动解包）
      if (v && typeof v === 'object' && v[__refKey]) return v.value;
      return v;
    },
    set: function (t, key, v) {
      // 与 Vue 一致的两条分支（文档里 #11 / #12 两个例子正好各走一条）：
      //   旧值是 ref 且新值**不是** ref → 写进那个 ref 的 .value
      //   新值是 ref → 直接替换这个属性（老 ref 就"断开"了）
      var cur = t[key];
      if (cur && typeof cur === 'object' && cur[__refKey] && !isRef(v)) {
        cur.value = v;
        return true;
      }
      return Reflect.set(t, key, __wrap(v));
    },
    deleteProperty: function (t, key) {
      return Reflect.deleteProperty(t, key);
    },
  });
  __proxyCache.set(target, proxy);
  __rawOf.set(proxy, target);
  __isProxy.add(proxy);
  return proxy;
}

function __collection(target) {
  var proxy = new Proxy(target, {
    get: function (t, key) {
      var v = t[key];
      if (typeof v === 'function') {
        return function () {
          var out = v.apply(t, arguments);
          if (key === 'get') return out && out[__refKey] ? out.value : out;
          if (key === 'set') return proxy;
          return out;
        };
      }
      return v;
    },
    set: function (t, key, v) {
      return t.set(key, __wrap(v));
    },
  });
  __isProxy.add(proxy);
  return proxy;
}

function ref(value) {
  var r = {
    get value() { return value; },
    set value(next) { value = next; },
  };
  // 不可枚举：不然打印出来会多一个 __v_isRef，和文档示例对不上
  return __markRef(r);
}

/** 打上"我是 ref"的记号；**不可枚举**，否则打印和文档对不上 */
function __markRef(obj) {
  Object.defineProperty(obj, __refKey, { value: true, enumerable: false, configurable: true });
  return obj;
}

function isRef(v) {
  return !!(v && typeof v === 'object' && v[__refKey]);
}

function reactive(target) {
  return __reactive(target);
}

function readonly(target) {
  return __reactive(target);
}

function shallowRef(value) {
  return ref(value);
}

function triggerRef() {}

function toRef(obj, key) {
  return ref(obj ? obj[key] : undefined);
}

function toRefs(obj) {
  var out = {};
  Object.keys(obj || {}).forEach(function (k) { out[k] = toRef(obj, k); });
  return out;
}

function computed(getter) {
  var cached;
  var dirty = true;
  var c = {
    get value() {
      if (dirty) {
        cached = typeof getter === 'function' ? getter() : getter.get();
        dirty = false;
      }
      return cached;
    },
  };
  return __markRef(c);
}

/* watch / 生命周期 / 组件 API：哑实现，只为让片段别报错。
   它们**不做响应式触发** —— 所以"靠 watch 回调打印"的片段不会产生输出，
   出题工具据此不会把它做成"预测输出"题（宁可不做，也不要给假期望）。 */
function watch() { return function () {}; }
function watchEffect() { return function () {}; }
function watchPostEffect() { return function () {}; }
function nextTick() { return Promise.resolve(); }
function onMounted() {}
function onUpdated() {}
function onUnmounted() {}
function onBeforeMount() {}
function onBeforeUnmount() {}
function onBeforeUpdate() {}
function defineProps() {
  // 文档里 props 常常是传入的 title；这里给个空壳，访问任何字段都是 undefined
  return new Proxy({}, { get: function () { return undefined; } });
}
function defineEmits() { return function () {}; }
function defineExpose() {}
function defineSlots() { return function () { return undefined; }; }
function useTemplateRef() { return ref(null); }
function useSlots() { return {}; }
function useAttrs() { return {}; }
function provide() {}
function inject() { return undefined; }
function h(tag) { return { tag: tag }; }
function createApp() { return { mount: function () {}, component: function () {}, use: function () {} }; }
function markRaw(v) { return v; }

Object.assign(globalThis, {
  ref: ref, isRef: isRef, reactive: reactive, readonly: readonly, shallowRef: shallowRef,
  triggerRef: triggerRef, toRef: toRef, toRefs: toRefs, computed: computed,
  watch: watch, watchEffect: watchEffect, watchPostEffect: watchPostEffect, nextTick: nextTick,
  onMounted: onMounted, onUpdated: onUpdated, onUnmounted: onUnmounted,
  onBeforeMount: onBeforeMount, onBeforeUnmount: onBeforeUnmount, onBeforeUpdate: onBeforeUpdate,
  defineProps: defineProps, defineEmits: defineEmits, defineExpose: defineExpose,
  defineSlots: defineSlots, useTemplateRef: useTemplateRef, useSlots: useSlots, useAttrs: useAttrs,
  provide: provide, inject: inject, h: h, createApp: createApp, markRaw: markRaw,
});
`

/** 运行时源码里不许出现 `</`（拼进 srcdoc 会被当成脚本结束）—— 注册时就炸掉，别等浏览器 */
if (SANDBOX_RUNTIME.includes('</')) {
  throw new Error('SANDBOX_RUNTIME 里出现了 "</"，拼进 srcdoc 会截断脚本')
}
