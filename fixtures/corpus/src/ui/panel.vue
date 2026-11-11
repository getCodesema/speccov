<script setup lang="ts">
// Left unparsed, and declared as such in the report: silence would read as "nothing here".
const orders = await Promise.all(ids.map((id) => loadOrder(id)));
</script>

<template>
    <ul></ul>
</template>
