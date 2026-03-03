import React, { useState } from 'react';
import { X, Server, Loader2, CheckCircle2, XCircle, KeyRound } from 'lucide-react';
import { addServer, testConnection } from '../api';

export default function AddServerModal({ isOpen, onClose, onServerAdded }) {
  const [form, setForm] = useState({ name: '', host: '', user: '', port: 22, key_path: '' });
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [error, setError] = useState(null);

  if (!isOpen) return null;

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.name === 'port' ? parseInt(e.target.value) || 22 : e.target.value });
    setTestResult(null);
    setError(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection(form);
      setTestResult(result);
    } catch (e) {
      setTestResult({ success: false, message: e.message });
    }
    setTesting(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const server = await addServer(form);
      onServerAdded(server);
      setForm({ name: '', host: '', user: '', port: 22, key_path: '' });
      onClose();
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      
      {/* Modal */}
      <div className="relative card p-6 w-full max-w-md mx-4 animate-fade-in shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-600/20 rounded-lg">
              <Server className="w-5 h-5 text-blue-400" />
            </div>
            <h2 className="text-lg font-semibold text-gray-100">Add a server</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-dark-800 rounded-lg transition-colors">
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Server name</label>
            <input
              name="name"
              value={form.name}
              onChange={handleChange}
              placeholder="Production, Staging..."
              className="input w-full"
              required
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-400 mb-1">Host</label>
              <input
                name="host"
                value={form.host}
                onChange={handleChange}
                placeholder="192.168.1.100"
                className="input w-full"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">Port</label>
              <input
                name="port"
                type="number"
                value={form.port}
                onChange={handleChange}
                className="input w-full"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">SSH user</label>
            <input
              name="user"
              value={form.user}
              onChange={handleChange}
              placeholder="root"
              className="input w-full"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">
              <span className="flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5" />
                SSH private key
              </span>
            </label>
            <input
              name="key_path"
              value={form.key_path}
              onChange={handleChange}
              placeholder="~/.ssh/id_rsa  or  ~/.ssh/my_key.pem"
              className="input w-full font-mono text-sm"
            />
            <p className="text-xs text-gray-600 mt-1">
              Absolute path to the private key. Leave empty to use the default SSH agent.
            </p>
          </div>

          {/* Test result */}
          {testResult && (
            <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${
              testResult.success 
                ? 'bg-green-950/40 text-green-400 border border-green-800/50' 
                : 'bg-red-950/40 text-red-400 border border-red-800/50'
            }`}>
              {testResult.success 
                ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> 
                : <XCircle className="w-4 h-4 flex-shrink-0" />
              }
              <span>{testResult.message}</span>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg text-sm bg-red-950/40 text-red-400 border border-red-800/50">
              <XCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || !form.host || !form.user}
              className="btn-ghost flex items-center gap-2 flex-1 justify-center disabled:opacity-40"
            >
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Test connection
            </button>
            <button
              type="submit"
              disabled={loading || !form.name || !form.host || !form.user}
              className="btn-primary flex items-center gap-2 flex-1 justify-center disabled:opacity-40"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Add
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
