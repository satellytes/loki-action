/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ 146:
/***/ ((module, __webpack_exports__, __nccwpck_require__) => {

"use strict";
__nccwpck_require__.a(module, async (__webpack_handle_async_dependencies__) => {
__nccwpck_require__.r(__webpack_exports__);
/* harmony export */ __nccwpck_require__.d(__webpack_exports__, {
/* harmony export */   "getClient": () => (/* binding */ getClient),
/* harmony export */   "fetchJobs": () => (/* binding */ fetchJobs),
/* harmony export */   "fetchLogs": () => (/* binding */ fetchLogs),
/* harmony export */   "getCommaSeparatedInput": () => (/* binding */ getCommaSeparatedInput),
/* harmony export */   "run": () => (/* binding */ run)
/* harmony export */ });
const core = __nccwpck_require__(43);
const process = __nccwpck_require__(282);
const HttpClient = (__nccwpck_require__(38).HttpClient);
const { createLogger, format } = __nccwpck_require__(909);
const LokiTransport = __nccwpck_require__(935);
const githubAPIUrl = "https://api.github.com";
const { printf } = format;
const gh_log_regex =
  /^\s?(?<timestamp>((19|20)[0-9][0-9])[-](0[1-9]|1[012])[-](0[1-9]|[12][0-9]|3[01])[T]([01][1-9]|[2][0-3])[:]([0-5][0-9])[:]([0-5][0-9])[.](?<nanosec>[0-9][0-9][0-9][0-9][0-9][0-9][0-9])[Z])\s(?<log>.*){0,1}/;

/**
 *
 * @param {*} ghToken
 * @returns
 */
function getClient(ghToken) {
  return new HttpClient("gh-http-client", [], {
    headers: {
      Authorization: `token ${ghToken}`,
      "Content-Type": "application/json",
    },
  });
}

/**
 *
 * @param {*} httpClient
 * @param {*} repo
 * @param {*} runId
 * @param {*} allowList
 * @returns
 */
async function fetchJobs(httpClient, repo, runId, allowList) {
  const url = `${githubAPIUrl}/repos/${repo}/actions/runs/${runId}/jobs`;
  const res = await httpClient.get(url);

  if (res.message.statusCode === undefined || res.message.statusCode >= 400) {
    throw new Error(`HTTP request failed: ${res.message.statusMessage}`);
  }

  const body = await res.readBody();
  const jobs = [];
  const all = allowList.length === 0;
  for (const j of JSON.parse(body).jobs) {
    // if there's an allow list, skip job accordingly
    if (!all && !allowList.includes(j.name)) {
      continue;
    }

    jobs.push({
      id: j.id,
      name: j.name,
    });
  }

  return jobs;
}

/**
 *
 * @param {*} httpClient
 * @param {*} repo
 * @param {*} job
 * @returns
 */

async function fetchLogs(httpClient, repo, job) {
  const url = `${githubAPIUrl}/repos/${repo}/actions/jobs/${job.id}/logs`;
  const res = await httpClient.get(url);

  if (res.message.statusCode === undefined || res.message.statusCode >= 400) {
    throw new Error(`HTTP request failed: ${res.message.statusMessage}`);
  }

  const body = await res.readBody();
  return body.split("\n");
}

/**
 *
 * @param {*} value
 * @returns
 */
function getCommaSeparatedInput(value) {
  let val = [];
  if (value !== "") {
    val = value.split(",");
    val = val.map((s) => s.trim());
  }

  return val;
}

async function run() {
  try {
    // retrieve config params

    // Github repo token
    const repoToken = core.getInput("repo-token", { required: true });
    // List of jobs to collect logs from (all jobs when empty)
    const jobNames = core.getInput("job-names", { required: false });
    const allowList = getCommaSeparatedInput(jobNames);
    // LogQL Push endpoint
    const endpoint = core.getInput("endpoint", { required: false });
    // LogQL endpoints (when endpoint is not present)
    const addrValue = core.getInput("addresses", { required: false });
    const addresses = getCommaSeparatedInput(addrValue);
    // LogQL partition ID
    const partitionId = core.getInput("partition", { required: false });
    // logql user
    const username = core.getInput("username", { required: false });
    // logql pass
    const password = core.getInput("password", { required: false });

    // Ensure either endpoint or addresses are set
    if (endpoint === "" && addresses.length === 0) {
      throw new Error(
        "invalid configuration: please set either endpoint or addresses"
      );
    }

    // get an authenticated HTTP client for the GitHub API
    const client = getClient(repoToken);

    // get all the jobs for the current workflow
    const workflowId = process.env["GITHUB_RUN_ID"] || "";
    const repo = process.env["GITHUB_REPOSITORY"] || "";
    core.debug(`Allow listing ${allowList.length} jobs in repo ${repo}`);
    const jobs = await fetchJobs(client, repo, workflowId, allowList);

    const onConnectionError = (err) => {
      core.debug("Error at connecting with logs endpoint\n", err);
    };
    const lokiBasicAuth = () => {
      if (username && password) {
        return `${username}:${password}`;
      }
      return "";
    };

    const lokiFmt = printf(({ message }) => {
      if (!message || message.length === 0) {
        return;
      }
      const line = message.match(gh_log_regex);
      if (!line?.groups?.log) {
        return message;
      }
      const { log } = line?.groups;
      const xlog = `${log}`;
      return xlog;
    });

    const options = (job) => {
      return {
        transports: [
          new LokiTransport({
            labels: {
              job: job?.name,
              jobId: job?.id,
              repo,
              workflowId,
              type: "github",
            },
            batching: false,
            format: lokiFmt,
            host: endpoint || addresses[0],
            gracefulShutdown: true,
            onConnectionError: onConnectionError,
            lokiBasicAuth: lokiBasicAuth(),
          }),
        ],
      };
    };
    const logger = (job) => createLogger(options(job));

    // get the logs for each job
    core.debug(`Getting logs for ${jobs.length} jobs`);
    for (const j of jobs) {
      const logs = logger(j);
      const lines = await fetchLogs(client, repo, j);
      core.debug(`Fetched ${lines.length} lines for job ${j.name}`);
      for (const l of lines) {
        try {
          if (l && l?.length > 0) {
            core.info(l)
            logs.info(l);
          }
        } catch (e) {
          core.warning(`Parser error ${e}`);
          logs.warning(`Error: ${e}`);
        }
      }
      logs.clear();
    }
  } catch (e) {
    core.setFailed(`Run failed: ${e}`);
  }
}

await run();

__webpack_handle_async_dependencies__();
}, 1);

/***/ }),

/***/ 43:
/***/ ((module) => {

module.exports = eval("require")("@actions/core");


/***/ }),

/***/ 38:
/***/ ((module) => {

module.exports = eval("require")("@actions/http-client");


/***/ }),

/***/ 909:
/***/ ((module) => {

module.exports = eval("require")("winston");


/***/ }),

/***/ 935:
/***/ ((module) => {

module.exports = eval("require")("winston-loki");


/***/ }),

/***/ 282:
/***/ ((module) => {

"use strict";
module.exports = require("process");

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __nccwpck_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId](module, module.exports, __nccwpck_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/async module */
/******/ 	(() => {
/******/ 		var webpackThen = typeof Symbol === "function" ? Symbol("webpack then") : "__webpack_then__";
/******/ 		var webpackExports = typeof Symbol === "function" ? Symbol("webpack exports") : "__webpack_exports__";
/******/ 		var completeQueue = (queue) => {
/******/ 			if(queue) {
/******/ 				queue.forEach((fn) => (fn.r--));
/******/ 				queue.forEach((fn) => (fn.r-- ? fn.r++ : fn()));
/******/ 			}
/******/ 		}
/******/ 		var completeFunction = (fn) => (!--fn.r && fn());
/******/ 		var queueFunction = (queue, fn) => (queue ? queue.push(fn) : completeFunction(fn));
/******/ 		var wrapDeps = (deps) => (deps.map((dep) => {
/******/ 			if(dep !== null && typeof dep === "object") {
/******/ 				if(dep[webpackThen]) return dep;
/******/ 				if(dep.then) {
/******/ 					var queue = [];
/******/ 					dep.then((r) => {
/******/ 						obj[webpackExports] = r;
/******/ 						completeQueue(queue);
/******/ 						queue = 0;
/******/ 					});
/******/ 					var obj = {};
/******/ 												obj[webpackThen] = (fn, reject) => (queueFunction(queue, fn), dep['catch'](reject));
/******/ 					return obj;
/******/ 				}
/******/ 			}
/******/ 			var ret = {};
/******/ 								ret[webpackThen] = (fn) => (completeFunction(fn));
/******/ 								ret[webpackExports] = dep;
/******/ 								return ret;
/******/ 		}));
/******/ 		__nccwpck_require__.a = (module, body, hasAwait) => {
/******/ 			var queue = hasAwait && [];
/******/ 			var exports = module.exports;
/******/ 			var currentDeps;
/******/ 			var outerResolve;
/******/ 			var reject;
/******/ 			var isEvaluating = true;
/******/ 			var nested = false;
/******/ 			var whenAll = (deps, onResolve, onReject) => {
/******/ 				if (nested) return;
/******/ 				nested = true;
/******/ 				onResolve.r += deps.length;
/******/ 				deps.map((dep, i) => (dep[webpackThen](onResolve, onReject)));
/******/ 				nested = false;
/******/ 			};
/******/ 			var promise = new Promise((resolve, rej) => {
/******/ 				reject = rej;
/******/ 				outerResolve = () => (resolve(exports), completeQueue(queue), queue = 0);
/******/ 			});
/******/ 			promise[webpackExports] = exports;
/******/ 			promise[webpackThen] = (fn, rejectFn) => {
/******/ 				if (isEvaluating) { return completeFunction(fn); }
/******/ 				if (currentDeps) whenAll(currentDeps, fn, rejectFn);
/******/ 				queueFunction(queue, fn);
/******/ 				promise['catch'](rejectFn);
/******/ 			};
/******/ 			module.exports = promise;
/******/ 			body((deps) => {
/******/ 				if(!deps) return outerResolve();
/******/ 				currentDeps = wrapDeps(deps);
/******/ 				var fn, result;
/******/ 				var promise = new Promise((resolve, reject) => {
/******/ 					fn = () => (resolve(result = currentDeps.map((d) => (d[webpackExports]))));
/******/ 					fn.r = 0;
/******/ 					whenAll(currentDeps, fn, reject);
/******/ 				});
/******/ 				return fn.r ? promise : result;
/******/ 			}).then(outerResolve, reject);
/******/ 			isEvaluating = false;
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter functions for harmony exports
/******/ 		__nccwpck_require__.d = (exports, definition) => {
/******/ 			for(var key in definition) {
/******/ 				if(__nccwpck_require__.o(definition, key) && !__nccwpck_require__.o(exports, key)) {
/******/ 					Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__nccwpck_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__nccwpck_require__.r = (exports) => {
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = __dirname + "/";
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module used 'module' so it can't be inlined
/******/ 	var __webpack_exports__ = __nccwpck_require__(146);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;