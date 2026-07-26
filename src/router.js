import { createRouter, createWebHistory } from 'vue-router'
import WatchView from './views/WatchView.vue'
import PublishView from './views/PublishView.vue'
import AdminView from './views/AdminView.vue'

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/watch' },
    { path: '/watch', alias: ['/rtc/whep', '/rtc/whep/'], component: WatchView },
    { path: '/admin', component: AdminView },
    { path: '/publish', alias: ['/rtc/whip', '/rtc/whip/'], component: PublishView },
    { path: '/:pathMatch(.*)*', redirect: '/watch' },
  ],
})
