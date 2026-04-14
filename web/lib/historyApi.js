const resolveFetcher = (api) => {
  if (api && typeof api.fetchApi === "function") {
    return (path, options = {}) => api.fetchApi(path, options);
  }
  return (path, options = {}) => fetch(path, options);
};

export function createHistoryApi(api) {
  const fetcher = resolveFetcher(api);

  const handleResponse = async (response) => {
    if (response.ok) {
      return response;
    }
    const message = await extractErrorMessage(response);
    throw new Error(message || `Request failed (${response.status})`);
  };

  const extractErrorMessage = async (response) => {
    try {
      const data = await response.json();
      if (data && typeof data.message === "string") {
        return data.message;
      }
    } catch (_) {
      /* swallow JSON failures */
    }
    return response.statusText;
  };

  const request = async (path, { parseJson = false, ...options } = {}) => {
    const handled = await handleResponse(await fetcher(path, options));
    return parseJson ? handled.json() : handled;
  };

  return {
    async list() {
      const payload = await request(`/prompt-history`, {
        method: "GET",
        parseJson: true,
      });
      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
      return entries;
    },

    async remove(entryId) {
      if (!entryId) {
        throw new Error("Entry id is required.");
      }
      await request(`/phg/delete_history_entry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry_id: entryId }),
      });
    },

    async deleteOutputFile(entryId, filename, subfolder = "", fileType = "") {
      if (!entryId || !filename) {
        throw new Error("Entry id and filename are required.");
      }
      await request(`/prompt-history/output/${entryId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, subfolder, type: fileType }),
      });
    },

    async deleteEverywhere(entryId, filename, subfolder = "", fileType = "") {
      if (!entryId || !filename) {
        throw new Error("Entry id and filename are required.");
      }
      await request(`/prompt-history/delete-everywhere/${entryId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, subfolder, type: fileType }),
      });
    },

    async deleteOthersExcept(entryId, keepFilename, keepSubfolder = "", keepType = "") {
      if (!entryId || !keepFilename) {
        throw new Error("Entry id and filename are required.");
      }
      await request(`/prompt-history/delete-others/${entryId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: keepFilename, subfolder: keepSubfolder, type: keepType }),
      });
    },

    async clear() {
      await request("/prompt-history", {
        method: "DELETE",
      });
    },
  };
}
