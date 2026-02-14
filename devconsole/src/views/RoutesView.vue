<template>
    <div class="view-padding">
        <h1 class="page-title">Routes</h1>
        <div v-if="loading" class="loading">Loading...</div>
        <div v-else-if="error" class="error">{{ error }}</div>
        <div v-else class="card">
            <table>
                <thead>
                    <tr>
                        <th>Methods</th>
                        <th>Path</th>
                        <th>Controller</th>
                        <th>Method</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="(route, i) in data" :key="i">
                        <td>
                            <span v-for="method in route.methods" :key="method" class="badge badge-blue" style="margin-right: 4px">
                                {{ method }}
                            </span>
                        </td>
                        <td class="mono">{{ route.path }}</td>
                        <td class="mono text-muted">{{ route.controller ?? '-' }}</td>
                        <td class="mono text-muted">{{ route.methodName ?? '-' }}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api, type RouteInfo } from '../api';

const data = ref<RouteInfo[]>([]);
const loading = ref(true);
const error = ref('');

onMounted(async () => {
    try {
        data.value = await api.routes();
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
});
</script>
