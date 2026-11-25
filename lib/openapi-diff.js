// 零依赖 Swagger 2.0 / OpenAPI 3.x Schema 差异比对引擎
// 自动识别破坏性变更（Breaking）与兼容变更（Non-Breaking），并生成 Markdown 联调比对报告

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

function resolvePointer(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = root;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object' || !Object.hasOwn(cur, part)) return null;
    cur = cur[part];
  }
  return cur;
}

function derefSchema(root, schema, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return { type: '$circular', ref: schema.$ref };
    const target = resolvePointer(root, schema.$ref);
    if (!target) return { type: '$unresolved', ref: schema.$ref };
    const nextSeen = new Set(seen);
    nextSeen.add(schema.$ref);
    const resolved = derefSchema(root, target, nextSeen);
    const { $ref, ...siblings } = schema;
    return Object.keys(siblings).length ? { ...resolved, ...siblings } : resolved;
  }
  if (Array.isArray(schema.allOf)) {
    const merged = { type: 'object', properties: {}, required: [] };
    for (const part of schema.allOf) {
      const r = derefSchema(root, part, seen);
      if (!r) continue;
      if (r.type && r.type !== 'object' && !Object.keys(merged.properties).length) merged.type = r.type;
      if (r.properties) Object.assign(merged.properties, r.properties);
      if (Array.isArray(r.required)) merged.required.push(...r.required);
      if (r.enum) merged.enum = r.enum;
    }
    merged.required = [...new Set(merged.required)];
    return merged;
  }
  return schema;
}

function schemaTypeSig(root, raw, seen = new Set()) {
  const s = derefSchema(root, raw, seen);
  if (!s) return 'any';
  if (Array.isArray(s.oneOf)) return `oneOf<${s.oneOf.map(x => schemaTypeSig(root, x, seen)).join('|')}>`;
  if (Array.isArray(s.anyOf)) return `anyOf<${s.anyOf.map(x => schemaTypeSig(root, x, seen)).join('|')}>`;
  const baseType = Array.isArray(s.type) ? s.type.join('|') : (s.type || (s.properties ? 'object' : s.items ? 'array' : 'any'));
  if (baseType === 'array') return `array<${schemaTypeSig(root, s.items, seen)}>`;
  const fmt = s.format ? `(${s.format})` : '';
  const nullable = s.nullable ? '?' : '';
  return `${baseType}${fmt}${nullable}`;
}

function flattenSchemaFields(root, raw, prefix = '', requiredFlag = false, out = new Map(), seen = new Set(), depth = 0) {
  if (!raw || depth > 8) return out;
  const s = derefSchema(root, raw, seen);
  if (!s) return out;
  const nextSeen = raw.$ref ? new Set([...seen, raw.$ref]) : seen;
  const sig = schemaTypeSig(root, s, nextSeen);
  const enumVals = Array.isArray(s.enum) ? s.enum.map(v => String(v)) : null;

  if (prefix) {
    out.set(prefix, { type: sig, required: Boolean(requiredFlag), enum: enumVals });
  } else if (!s.properties && s.type !== 'array') {
    out.set('$root', { type: sig, required: Boolean(requiredFlag), enum: enumVals });
  }

  if (s.properties && typeof s.properties === 'object') {
    const reqSet = new Set(Array.isArray(s.required) ? s.required : []);
    for (const [prop, child] of Object.entries(s.properties)) {
      const nextPrefix = prefix ? `${prefix}.${prop}` : prop;
      flattenSchemaFields(root, child, nextPrefix, reqSet.has(prop), out, nextSeen, depth + 1);
    }
  } else if ((s.type === 'array' || s.items) && s.items) {
    const nextPrefix = prefix ? `${prefix}[]` : '[]';
    flattenSchemaFields(root, s.items, nextPrefix, false, out, nextSeen, depth + 1);
  }
  return out;
}

function pickJsonSchema(contentObj) {
  if (!contentObj || typeof contentObj !== 'object') return null;
  const preferred = ['application/json', 'application/problem+json', '*/*'];
  for (const key of preferred) {
    if (contentObj[key]?.schema) return contentObj[key].schema;
  }
  const firstKey = Object.keys(contentObj).find(k => k.includes('json') && contentObj[k]?.schema)
    || Object.keys(contentObj).find(k => contentObj[k]?.schema);
  return firstKey ? contentObj[firstKey].schema : null;
}

function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('OpenAPI/Swagger 文档必须是合法的 JSON 对象');
  }
  const isV3 = typeof spec.openapi === 'string';
  const isV2 = typeof spec.swagger === 'string';
  if (!isV3 && !isV2 && !spec.paths) {
    throw new Error('未检测到 OpenAPI 3.x (openapi) 或 Swagger 2.0 (swagger) 规范字段');
  }
  const version = spec.info?.version || '';
  const title = spec.info?.title || '';
  const endpoints = new Map();

  for (const [routePath, pathItemRaw] of Object.entries(spec.paths || {})) {
    const pathItem = derefSchema(spec, pathItemRaw) || {};
    const pathParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const [method, opRaw] of Object.entries(pathItem)) {
      const lower = method.toLowerCase();
      if (!HTTP_METHODS.has(lower) || !opRaw || typeof opRaw !== 'object') continue;
      const key = `${lower.toUpperCase()} ${routePath}`;

      // 参数合并（path 级 + operation 级）
      const paramMap = new Map();
      let swaggerBodySchema = null;
      let swaggerBodyRequired = false;
      for (const pRaw of [...pathParams, ...(Array.isArray(opRaw.parameters) ? opRaw.parameters : [])]) {
        const p = derefSchema(spec, pRaw);
        if (!p || !p.name) continue;
        if (p.in === 'body') {
          swaggerBodySchema = p.schema || null;
          swaggerBodyRequired = Boolean(p.required);
          continue;
        }
        const pKey = `${p.in || 'query'}:${p.name}`;
        const pSchema = p.schema || p;
        paramMap.set(pKey, {
          name: p.name,
          in: p.in || 'query',
          required: Boolean(p.required),
          type: schemaTypeSig(spec, pSchema),
          enum: Array.isArray(pSchema?.enum) ? pSchema.enum.map(String) : null,
        });
      }

      // 请求体
      let requestSchema = swaggerBodySchema;
      let requestRequired = swaggerBodyRequired;
      if (opRaw.requestBody) {
        const rb = derefSchema(spec, opRaw.requestBody);
        requestSchema = pickJsonSchema(rb?.content);
        requestRequired = Boolean(rb?.required);
      }
      const requestFields = flattenSchemaFields(spec, requestSchema);

      // 响应体（按状态码）
      const responses = new Map();
      for (const [code, respRaw] of Object.entries(opRaw.responses || {})) {
        const resp = derefSchema(spec, respRaw) || {};
        const respSchema = isV3 ? pickJsonSchema(resp.content) : (resp.schema || null);
        responses.set(String(code), {
          code: String(code),
          fields: flattenSchemaFields(spec, respSchema),
        });
      }

      endpoints.set(key, {
        key,
        method: lower.toUpperCase(),
        path: routePath,
        summary: opRaw.summary || '',
        deprecated: Boolean(opRaw.deprecated),
        params: paramMap,
        requestRequired,
        requestFields,
        responses,
      });
    }
  }

  return { specFormat: isV3 ? `OpenAPI ${spec.openapi}` : isV2 ? `Swagger ${spec.swagger}` : 'OpenAPI', title, version, endpoints };
}

function compareFieldMaps(direction, scope, oldFields, newFields, breaking, nonBreaking) {
  // direction: 'request' | 'response'
  for (const [field, oldInfo] of oldFields) {
    if (!newFields.has(field)) {
      if (direction === 'response') {
        breaking.push({ category: 'response_field_removed', endpoint: scope, field, detail: `响应字段 \`${field}\` (${oldInfo.type}) 被移除` });
      } else {
        nonBreaking.push({ category: 'request_field_removed', endpoint: scope, field, detail: `请求字段 \`${field}\` 被移除` });
      }
      continue;
    }
    const newInfo = newFields.get(field);
    if (oldInfo.type !== newInfo.type) {
      breaking.push({
        category: `${direction}_type_changed`,
        endpoint: scope,
        field,
        detail: `${direction === 'request' ? '请求' : '响应'}字段 \`${field}\` 类型变更：\`${oldInfo.type}\` → \`${newInfo.type}\``,
      });
    }
    if (direction === 'request' && !oldInfo.required && newInfo.required) {
      breaking.push({ category: 'request_field_now_required', endpoint: scope, field, detail: `请求字段 \`${field}\` 由可选变为必填` });
    } else if (direction === 'request' && oldInfo.required && !newInfo.required) {
      nonBreaking.push({ category: 'request_field_now_optional', endpoint: scope, field, detail: `请求字段 \`${field}\` 由必填放宽为可选` });
    } else if (direction === 'response' && oldInfo.required && !newInfo.required) {
      breaking.push({ category: 'response_field_now_optional', endpoint: scope, field, detail: `响应字段 \`${field}\` 由必返变为可选（可能缺失）` });
    }

    if (oldInfo.enum || newInfo.enum) {
      const oldSet = new Set(oldInfo.enum || []);
      const newSet = new Set(newInfo.enum || []);
      const removedEnums = [...oldSet].filter(v => !newSet.has(v));
      const addedEnums = [...newSet].filter(v => !oldSet.has(v));
      if (removedEnums.length && oldSet.size) {
        const list = direction === 'request' ? breaking : nonBreaking;
        list.push({
          category: `${direction}_enum_removed`,
          endpoint: scope,
          field,
          detail: `${direction === 'request' ? '请求' : '响应'}字段 \`${field}\` 移除枚举值：${removedEnums.join(', ')}`,
        });
      }
      if (addedEnums.length && newSet.size) {
        const list = direction === 'response' ? breaking : nonBreaking;
        list.push({
          category: `${direction}_enum_added`,
          endpoint: scope,
          field,
          detail: `${direction === 'request' ? '请求' : '响应'}字段 \`${field}\` 新增枚举值：${addedEnums.join(', ')}`,
        });
      }
    }
  }

  for (const [field, newInfo] of newFields) {
    if (oldFields.has(field)) continue;
    if (direction === 'request' && newInfo.required) {
      breaking.push({ category: 'request_required_field_added', endpoint: scope, field, detail: `新增必填请求字段 \`${field}\` (${newInfo.type})` });
    } else {
      nonBreaking.push({
        category: `${direction}_field_added`,
        endpoint: scope,
        field,
        detail: `新增${direction === 'request' ? '可选请求' : '响应'}字段 \`${field}\` (${newInfo.type})`,
      });
    }
  }
}

function diffOpenApi(baseSpec, targetSpec, { baseLabel = 'Base', targetLabel = 'Target' } = {}) {
  const base = normalizeSpec(baseSpec);
  const target = normalizeSpec(targetSpec);
  const breaking = [];
  const nonBreaking = [];
  const info = [];

  if (base.title !== target.title || base.version !== target.version) {
    info.push({ detail: `文档元信息变更：${base.title || '(无标题)'} ${base.version || ''} → ${target.title || '(无标题)'} ${target.version || ''}` });
  }

  for (const [key, oldEp] of base.endpoints) {
    if (!target.endpoints.has(key)) {
      breaking.push({ category: 'endpoint_removed', endpoint: key, detail: `接口 \`${key}\` 被删除` });
      continue;
    }
    const newEp = target.endpoints.get(key);
    if (!oldEp.deprecated && newEp.deprecated) {
      nonBreaking.push({ category: 'endpoint_deprecated', endpoint: key, detail: `接口 \`${key}\` 标记为已废弃 (deprecated)` });
    }

    // 参数对比
    for (const [pKey, oldP] of oldEp.params) {
      if (!newEp.params.has(pKey)) {
        breaking.push({ category: 'param_removed', endpoint: key, field: pKey, detail: `参数 \`${oldP.name}\` (${oldP.in}) 被移除` });
        continue;
      }
      const newP = newEp.params.get(pKey);
      if (oldP.type !== newP.type) {
        breaking.push({ category: 'param_type_changed', endpoint: key, field: pKey, detail: `参数 \`${oldP.name}\` (${oldP.in}) 类型变更：\`${oldP.type}\` → \`${newP.type}\`` });
      }
      if (!oldP.required && newP.required) {
        breaking.push({ category: 'param_now_required', endpoint: key, field: pKey, detail: `参数 \`${oldP.name}\` (${oldP.in}) 由可选变为必填` });
      } else if (oldP.required && !newP.required) {
        nonBreaking.push({ category: 'param_now_optional', endpoint: key, field: pKey, detail: `参数 \`${oldP.name}\` (${oldP.in}) 由必填变为可选` });
      }
    }
    for (const [pKey, newP] of newEp.params) {
      if (oldEp.params.has(pKey)) continue;
      if (newP.required) {
        breaking.push({ category: 'required_param_added', endpoint: key, field: pKey, detail: `新增必填参数 \`${newP.name}\` (${newP.in}, ${newP.type})` });
      } else {
        nonBreaking.push({ category: 'optional_param_added', endpoint: key, field: pKey, detail: `新增可选参数 \`${newP.name}\` (${newP.in}, ${newP.type})` });
      }
    }

    // 请求体对比
    if (!oldEp.requestRequired && newEp.requestRequired && oldEp.requestFields.size === 0 && newEp.requestFields.size > 0) {
      breaking.push({ category: 'request_body_now_required', endpoint: key, detail: '请求体由无/可选变为必填' });
    }
    compareFieldMaps('request', key, oldEp.requestFields, newEp.requestFields, breaking, nonBreaking);

    // 响应对比
    for (const [code, oldR] of oldEp.responses) {
      if (!newEp.responses.has(code)) {
        if (/^2/.test(code)) {
          breaking.push({ category: 'response_code_removed', endpoint: key, detail: `成功响应状态码 \`${code}\` 被移除` });
        } else {
          nonBreaking.push({ category: 'response_code_removed', endpoint: key, detail: `响应状态码 \`${code}\` 被移除` });
        }
        continue;
      }
      const newR = newEp.responses.get(code);
      compareFieldMaps('response', `${key} [${code}]`, oldR.fields, newR.fields, breaking, nonBreaking);
    }
    for (const [code] of newEp.responses) {
      if (!oldEp.responses.has(code)) {
        nonBreaking.push({ category: 'response_code_added', endpoint: key, detail: `新增响应状态码 \`${code}\`` });
      }
    }
  }

  for (const [key, newEp] of target.endpoints) {
    if (!base.endpoints.has(key)) {
      nonBreaking.push({ category: 'endpoint_added', endpoint: key, detail: `新增接口 \`${key}\`${newEp.summary ? `（${newEp.summary}）` : ''}` });
    }
  }

  const summary = {
    baseEndpoints: base.endpoints.size,
    targetEndpoints: target.endpoints.size,
    breakingCount: breaking.length,
    nonBreakingCount: nonBreaking.length,
    compatible: breaking.length === 0,
  };

  const md = [
    `# OpenAPI Schema 差异比对报告`,
    '',
    `- 基准版本：\`${baseLabel}\`（${base.specFormat}${base.title ? ` · ${base.title}` : ''}${base.version ? ` v${base.version}` : ''}，共 ${base.endpoints.size} 个接口）`,
    `- 目标版本：\`${targetLabel}\`（${target.specFormat}${target.title ? ` · ${target.title}` : ''}${target.version ? ` v${target.version}` : ''}，共 ${target.endpoints.size} 个接口）`,
    `- 兼容性结论：${summary.compatible ? '✅ **向后兼容（无破坏性变更）**' : `⚠️ **存在 ${breaking.length} 项破坏性变更，建议发起 proposal 经双方人类拍板后再改代码**`}`,
    `- 统计：破坏性变更 **${breaking.length}** 项 · 兼容变更 **${nonBreaking.length}** 项`,
    '',
  ];
  if (info.length) {
    md.push('## 元信息变更', ...info.map(x => `- ${x.detail}`), '');
  }
  if (breaking.length) {
    md.push('## ⚠️ 破坏性变更（Breaking Changes）', ...breaking.map(x => `- **${x.endpoint}**：${x.detail}`), '');
  }
  if (nonBreaking.length) {
    md.push('## ✅ 兼容变更（Non-Breaking Changes）', ...nonBreaking.map(x => `- **${x.endpoint}**：${x.detail}`), '');
  }
  if (!breaking.length && !nonBreaking.length && !info.length) {
    md.push('两份 OpenAPI / Swagger Schema 完全一致，未发现接口结构差异。', '');
  }

  return {
    base: { label: baseLabel, format: base.specFormat, title: base.title, version: base.version, endpoints: base.endpoints.size },
    target: { label: targetLabel, format: target.specFormat, title: target.title, version: target.version, endpoints: target.endpoints.size },
    summary,
    breaking,
    nonBreaking,
    info,
    markdown: md.join('\n'),
  };
}

module.exports = { diffOpenApi, normalizeSpec };
